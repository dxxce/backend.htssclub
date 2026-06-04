import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { GameMode, GameType, RoomStatus } from '../../common/enums';
import { UsersService } from '../../users/users.service';
import { WagerService } from './wager.service';
import {
  GameRoom,
  GameRoomDocument,
  RoomMember,
} from './schemas/game-room.schema';

export interface CreateRoomInput {
  game: GameType;
  mode: GameMode;
  betAmount?: number;
  maxPlayers: number;
  minPlayers: number;
  name?: string;
  isPrivate?: boolean;
}

/**
 * Generic lobby management shared by Caro and Tien Len. Handles room
 * creation, join/leave with coin escrow (WAGER), readiness, listing open
 * rooms, and start/cancel. The concrete game module supplies a launcher that
 * turns a full room into a running game.
 */
@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);

  constructor(
    @InjectModel(GameRoom.name)
    private readonly model: Model<GameRoomDocument>,
    private readonly users: UsersService,
    private readonly wager: WagerService,
  ) {}

  private codePrefix(game: GameType): string {
    return game === GameType.CARO ? 'CR' : 'TL';
  }

  private genCode(game: GameType): string {
    const raw = randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
    return `${this.codePrefix(game)}-${raw}`;
  }

  async getOrThrow(roomId: string): Promise<GameRoomDocument> {
    if (!Types.ObjectId.isValid(roomId)) {
      throw new NotFoundException('Room not found');
    }
    const room = await this.model.findById(roomId).exec();
    if (!room) throw new NotFoundException('Room not found');
    return room;
  }

  async getByCode(code: string): Promise<GameRoomDocument> {
    const room = await this.model.findOne({ code: code.toUpperCase() }).exec();
    if (!room) throw new NotFoundException('Room not found');
    return room;
  }

  isMember(room: GameRoomDocument, userId: string): boolean {
    return room.members.some((m) => m.userId.toString() === userId);
  }

  /** Creates a room and adds the host as the first member (escrowing if WAGER). */
  async create(
    hostId: string,
    input: CreateRoomInput,
  ): Promise<GameRoomDocument> {
    if (input.minPlayers < 2 || input.maxPlayers < input.minPlayers) {
      throw new BadRequestException('Invalid player counts');
    }
    const bet = input.mode === GameMode.WAGER ? Math.floor(input.betAmount ?? 0) : 0;
    if (input.mode === GameMode.WAGER && bet <= 0) {
      throw new BadRequestException('Bet amount must be > 0 for wager rooms');
    }

    // Generate a unique code (retry a few times on the rare collision).
    let code = this.genCode(input.game);
    for (let i = 0; i < 5; i++) {
      const exists = await this.model.exists({ code });
      if (!exists) break;
      code = this.genCode(input.game);
    }

    const room = await this.model.create({
      game: input.game,
      mode: input.mode,
      code,
      isPrivate: input.isPrivate ?? false,
      name: input.name,
      hostId: new Types.ObjectId(hostId),
      betAmount: bet,
      minPlayers: input.minPlayers,
      maxPlayers: input.maxPlayers,
      members: [],
      status: RoomStatus.WAITING,
      pot: 0,
    });
    // Host joins their own room (collects stake if WAGER).
    await this.join(room._id.toString(), hostId);
    return this.getOrThrow(room._id.toString());
  }

  /** Adds a user to a room, escrowing their stake for WAGER rooms. */
  async join(roomId: string, userId: string): Promise<GameRoomDocument> {
    const room = await this.getOrThrow(roomId);
    if (room.status !== RoomStatus.WAITING) {
      throw new BadRequestException('Room is not open for joining');
    }
    if (this.isMember(room, userId)) return room;
    if (room.members.length >= room.maxPlayers) {
      throw new BadRequestException('Room is full');
    }

    // Collect the stake BEFORE adding (so a failed debit doesn't seat them).
    let staked = false;
    if (room.mode === GameMode.WAGER) {
      await this.wager.collectStake(userId, room.betAmount, room.code);
      staked = true;
    }
    const member: RoomMember = {
      userId: new Types.ObjectId(userId),
      staked,
      ready: false,
      joinedAt: new Date(),
    };
    const updated = await this.model
      .findOneAndUpdate(
        { _id: room._id, status: RoomStatus.WAITING },
        {
          $push: { members: member },
          $inc: { pot: staked ? room.betAmount : 0 },
        },
        { new: true },
      )
      .exec();
    if (!updated) {
      // Room changed under us; refund the stake we just took.
      if (staked) {
        await this.wager.refund(userId, room.betAmount, room.code);
      }
      throw new BadRequestException('Room is no longer joinable');
    }
    return updated;
  }

  /**
   * Removes a user from a WAITING room and refunds their stake. If the host
   * leaves, the room is cancelled (everyone refunded). Returns the updated
   * room or null if the room was closed/removed.
   */
  async leave(
    roomId: string,
    userId: string,
  ): Promise<{ room: GameRoomDocument | null; cancelled: boolean }> {
    const room = await this.getOrThrow(roomId);
    if (!this.isMember(room, userId)) {
      return { room, cancelled: false };
    }
    if (room.status === RoomStatus.WAITING && room.hostId.toString() === userId) {
      await this.cancel(room);
      return { room: null, cancelled: true };
    }
    if (room.status !== RoomStatus.WAITING) {
      // Can't leave a started game through the lobby; that's a resign/forfeit.
      throw new BadRequestException('Game already started');
    }
    const member = room.members.find((m) => m.userId.toString() === userId);
    const refundAmt = member?.staked ? room.betAmount : 0;
    const updated = await this.model
      .findByIdAndUpdate(
        room._id,
        {
          $pull: { members: { userId: new Types.ObjectId(userId) } },
          $inc: { pot: -refundAmt },
        },
        { new: true },
      )
      .exec();
    if (refundAmt > 0) {
      await this.wager.refund(userId, refundAmt, room.code);
    }
    return { room: updated, cancelled: false };
  }

  /** Cancels a room and refunds all staked members. */
  async cancel(room: GameRoomDocument): Promise<void> {
    if (room.status === RoomStatus.CLOSED) return;
    room.status = RoomStatus.CLOSED;
    room.closedAt = new Date();
    await room.save();
    if (room.mode === GameMode.WAGER) {
      const stakedUsers = room.members
        .filter((m) => m.staked)
        .map((m) => m.userId.toString());
      await this.wager.refundMany(stakedUsers, room.betAmount, room.code);
    }
  }

  async setReady(
    roomId: string,
    userId: string,
    ready: boolean,
  ): Promise<GameRoomDocument> {
    const room = await this.getOrThrow(roomId);
    if (!this.isMember(room, userId)) {
      throw new ForbiddenException('Not a member of this room');
    }
    await this.model
      .updateOne(
        { _id: room._id, 'members.userId': new Types.ObjectId(userId) },
        { $set: { 'members.$.ready': ready } },
      )
      .exec();
    return this.getOrThrow(roomId);
  }

  /**
   * Validates that the host can start: enough players, all non-host members
   * ready. Flips the room to STARTING (atomic guard) and returns it. The
   * caller then launches the concrete game and calls `markInProgress`.
   */
  async beginStart(
    roomId: string,
    userId: string,
  ): Promise<GameRoomDocument> {
    const room = await this.getOrThrow(roomId);
    if (room.hostId.toString() !== userId) {
      throw new ForbiddenException('Only the host can start');
    }
    if (room.status !== RoomStatus.WAITING) {
      throw new BadRequestException('Room is not waiting');
    }
    if (room.members.length < room.minPlayers) {
      throw new BadRequestException(
        `Need at least ${room.minPlayers} players`,
      );
    }
    const everyoneReady = room.members
      .filter((m) => m.userId.toString() !== room.hostId.toString())
      .every((m) => m.ready);
    if (!everyoneReady) {
      throw new BadRequestException('Not all players are ready');
    }
    const updated = await this.model
      .findOneAndUpdate(
        { _id: room._id, status: RoomStatus.WAITING },
        { $set: { status: RoomStatus.STARTING } },
        { new: true },
      )
      .exec();
    if (!updated) throw new BadRequestException('Room is no longer waiting');
    return updated;
  }

  async markInProgress(
    roomId: string,
    gameId: string,
  ): Promise<GameRoomDocument> {
    const updated = await this.model
      .findByIdAndUpdate(
        roomId,
        {
          $set: {
            status: RoomStatus.IN_PROGRESS,
            gameId: new Types.ObjectId(gameId),
            startedAt: new Date(),
          },
        },
        { new: true },
      )
      .exec();
    if (!updated) throw new NotFoundException('Room not found');
    return updated;
  }

  /** Rolls a STARTING room back to WAITING if launching the game failed. */
  async revertToWaiting(roomId: string): Promise<void> {
    await this.model
      .updateOne(
        { _id: roomId, status: RoomStatus.STARTING },
        { $set: { status: RoomStatus.WAITING } },
      )
      .exec();
  }

  async close(roomId: string): Promise<void> {
    await this.model
      .updateOne(
        { _id: roomId },
        { $set: { status: RoomStatus.CLOSED, closedAt: new Date() } },
      )
      .exec();
  }

  /** Lists open public rooms for a game (lobby browser). */
  async listOpen(game: GameType, limit = 50): Promise<any[]> {
    const rooms = await this.model
      .find({ game, status: RoomStatus.WAITING, isPrivate: false })
      .sort({ _id: -1 })
      .limit(Math.min(limit, 100))
      .exec();
    return Promise.all(rooms.map((r) => this.publicView(r)));
  }

  /** A WAITING/active room the user currently belongs to (for reconnection). */
  async myRoom(game: GameType, userId: string): Promise<any | null> {
    const room = await this.model
      .findOne({
        game,
        status: { $in: [RoomStatus.WAITING, RoomStatus.STARTING, RoomStatus.IN_PROGRESS] },
        'members.userId': new Types.ObjectId(userId),
      })
      .sort({ _id: -1 })
      .exec();
    return room ? this.publicView(room) : null;
  }

  /** Full client-facing view of a room with member cards. */
  async publicView(room: GameRoomDocument): Promise<any> {
    const ids = room.members.map((m) => m.userId.toString());
    const cards = await this.users.getCards(ids);
    return {
      id: room._id.toString(),
      game: room.game,
      mode: room.mode,
      code: room.code,
      isPrivate: room.isPrivate,
      name: room.name ?? null,
      hostId: room.hostId.toString(),
      betAmount: room.betAmount,
      pot: room.pot,
      minPlayers: room.minPlayers,
      maxPlayers: room.maxPlayers,
      status: room.status,
      gameId: room.gameId?.toString() ?? null,
      members: room.members.map((m) => ({
        userId: m.userId.toString(),
        user: cards.get(m.userId.toString()) ?? {
          id: m.userId.toString(),
          username: 'unknown',
        },
        ready: m.ready,
        isHost: m.userId.toString() === room.hostId.toString(),
      })),
    };
  }
}

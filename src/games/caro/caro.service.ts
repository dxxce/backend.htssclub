import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { RealtimeService } from '../../realtime/realtime.service';
import { LevelingService } from '../../leveling/leveling.service';
import { UsersService } from '../../users/users.service';
import {
  applyMove,
  Board,
  BOARD_SIZE,
  Cell,
  createBoard,
} from './caro.logic';
import { drawOutcome, rankedOutcome } from './elo.util';
import {
  CaroEndReason,
  CaroGame,
  CaroGameDocument,
  CaroStatus,
} from './schemas/caro-game.schema';
import { GameMode } from '../../common/enums';
import { WagerService } from '../common/wager.service';
import { RoomsService } from '../common/rooms.service';

export const TURN_SECONDS = 30; // per-move time limit
const RECONNECT_GRACE_MS = 30_000; // time allowed to return after disconnect

interface PublicPlayer {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  rankPoints?: number;
}

@Injectable()
export class CaroService {
  private readonly logger = new Logger(CaroService.name);
  // Per-game turn timers (this instance). Cleared on move/finish.
  private timers = new Map<string, NodeJS.Timeout>();
  // Disconnect grace timers keyed by `${gameId}:${userId}`.
  private dcTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @InjectModel(CaroGame.name)
    private readonly model: Model<CaroGameDocument>,
    private readonly realtime: RealtimeService,
    private readonly leveling: LevelingService,
    private readonly users: UsersService,
    private readonly wager: WagerService,
    private readonly rooms: RoomsService,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────

  /** Creates a fresh game; playerX moves first. Broadcasts game:start. */
  async createGame(
    playerXId: string,
    playerOId: string,
    opts: {
      mode?: GameMode;
      ranked?: boolean;
      betAmount?: number;
      roomId?: string;
    } = {},
  ): Promise<CaroGameDocument> {
    // Backward-compatible: `ranked` boolean maps to RANKED/CASUAL when no mode.
    const mode =
      opts.mode ?? (opts.ranked === false ? GameMode.CASUAL : GameMode.RANKED);
    const betAmount = mode === GameMode.WAGER ? Math.floor(opts.betAmount ?? 0) : 0;
    const game = await this.model.create({
      playerX: new Types.ObjectId(playerXId),
      playerO: new Types.ObjectId(playerOId),
      ranked: mode === GameMode.RANKED,
      mode,
      betAmount,
      pot: betAmount * 2,
      roomId: opts.roomId ? new Types.ObjectId(opts.roomId) : undefined,
      status: CaroStatus.ACTIVE,
      board: createBoard(),
      moves: [],
      turn: 1,
    });
    const view = await this.publicView(game);
    // Notify both players directly (they may not be in the room yet).
    [playerXId, playerOId].forEach((uid) =>
      this.realtime.emitToCaroUser(uid, 'caro:matched', view),
    );
    this.startTurnTimer(game._id.toString());
    return game;
  }

  /**
   * Launches a Caro game from a full lobby room (exactly 2 members). The room
   * has already escrowed both stakes (WAGER). Marks the room IN_PROGRESS and
   * links the game id. Returns the game.
   */
  async launchFromRoom(room: {
    id: string;
    mode: GameMode;
    betAmount: number;
    memberIds: string[];
  }): Promise<CaroGameDocument> {
    if (room.memberIds.length !== 2) {
      throw new BadRequestException('Caro requires exactly 2 players');
    }
    const [a, b] = room.memberIds;
    const [xId, oId] = Math.random() < 0.5 ? [a, b] : [b, a];
    const game = await this.createGame(xId, oId, {
      mode: room.mode,
      betAmount: room.betAmount,
      roomId: room.id,
    });
    await this.rooms.markInProgress(room.id, game._id.toString());
    return game;
  }

  /** Full client-facing view of a game (board, players, turn, status...). */
  async publicView(game: CaroGameDocument): Promise<any> {
    const cards = await this.users.getCards([
      game.playerX.toString(),
      game.playerO.toString(),
    ]);
    const toPlayer = (id: string): PublicPlayer => {
      const c = cards.get(id);
      return c
        ? { id, username: c.username, displayName: c.displayName, avatarUrl: c.avatarUrl }
        : { id, username: 'unknown' };
    };
    return {
      id: game._id.toString(),
      boardSize: BOARD_SIZE,
      board: game.board,
      moves: game.moves,
      turn: game.turn, // 1 = X to move, 2 = O to move
      status: game.status,
      ranked: game.ranked,
      mode: game.mode,
      betAmount: game.betAmount,
      pot: game.pot,
      roomId: game.roomId?.toString() ?? null,
      players: {
        X: toPlayer(game.playerX.toString()),
        O: toPlayer(game.playerO.toString()),
      },
      winner: game.winner?.toString() ?? null,
      endReason: game.endReason ?? null,
      winningLine: game.winningLine ?? null,
      rpChange: game.rpChange ?? null,
      turnSeconds: TURN_SECONDS,
    };
  }

  async getGameOrThrow(gameId: string): Promise<CaroGameDocument> {
    if (!Types.ObjectId.isValid(gameId)) {
      throw new NotFoundException('Game not found');
    }
    const game = await this.model.findById(gameId).exec();
    if (!game) throw new NotFoundException('Game not found');
    return game;
  }

  /** Mark of a participant: 1 (X), 2 (O), or 0 if not a player. */
  private markOf(game: CaroGameDocument, userId: string): Cell {
    if (game.playerX.toString() === userId) return 1;
    if (game.playerO.toString() === userId) return 2;
    return 0;
  }

  private opponentOf(game: CaroGameDocument, userId: string): string {
    return game.playerX.toString() === userId
      ? game.playerO.toString()
      : game.playerX.toString();
  }

  // ── Moves ─────────────────────────────────────────────────────
  async move(
    gameId: string,
    userId: string,
    row: number,
    col: number,
  ): Promise<any> {
    const game = await this.getGameOrThrow(gameId);
    if (game.status !== CaroStatus.ACTIVE) {
      throw new BadRequestException('Game is not active');
    }
    const mark = this.markOf(game, userId);
    if (mark === 0) throw new ForbiddenException('Not a player in this game');
    if (game.turn !== mark) throw new BadRequestException('Not your turn');

    const board = game.board as Board;
    const result = applyMove(board, row, col, mark);
    if (!result.ok) throw new BadRequestException(result.error || 'Invalid move');

    game.board = board;
    game.moves.push({ by: mark, row, col, at: new Date() });

    if (result.win) {
      game.winningLine = result.winningLine;
      await this.finish(game, userId, CaroEndReason.WIN);
      return this.publicView(game);
    }
    if (result.draw) {
      await this.finishDraw(game);
      return this.publicView(game);
    }

    // Switch turn, persist, reset clock, broadcast the move.
    game.turn = mark === 1 ? 2 : 1;
    await game.save();
    this.startTurnTimer(gameId);

    this.broadcast(gameId, 'caro:move', {
      gameId,
      by: userId,
      mark,
      row,
      col,
      nextTurn: game.turn,
    });
    return this.publicView(game);
  }

  // ── Resign / timeout / disconnect ─────────────────────────────
  async resign(gameId: string, userId: string): Promise<any> {
    const game = await this.getGameOrThrow(gameId);
    if (game.status !== CaroStatus.ACTIVE) {
      throw new BadRequestException('Game is not active');
    }
    if (this.markOf(game, userId) === 0) {
      throw new ForbiddenException('Not a player in this game');
    }
    const winner = this.opponentOf(game, userId);
    await this.finish(game, winner, CaroEndReason.RESIGN);
    return this.publicView(game);
  }

  /** Called by the gateway when a player's socket disconnects mid-game. */
  async onDisconnect(gameId: string, userId: string): Promise<void> {
    const game = await this.model.findById(gameId).exec();
    if (!game || game.status !== CaroStatus.ACTIVE) return;
    if (this.markOf(game, userId) === 0) return;
    this.broadcast(gameId, 'caro:opponent-disconnected', {
      gameId,
      userId,
      graceMs: RECONNECT_GRACE_MS,
    });
    const key = `${gameId}:${userId}`;
    this.clearDcTimer(key);
    this.dcTimers.set(
      key,
      setTimeout(() => {
        void this.forfeitDisconnected(gameId, userId);
      }, RECONNECT_GRACE_MS),
    );
  }

  /** Called when a player's socket reconnects to the game room. */
  async onReconnect(gameId: string, userId: string): Promise<void> {
    this.clearDcTimer(`${gameId}:${userId}`);
    this.broadcast(gameId, 'caro:opponent-reconnected', { gameId, userId });
  }

  private async forfeitDisconnected(gameId: string, userId: string) {
    const game = await this.model.findById(gameId).exec();
    if (!game || game.status !== CaroStatus.ACTIVE) return;
    const winner = this.opponentOf(game, userId);
    await this.finish(game, winner, CaroEndReason.DISCONNECT);
  }

  private startTurnTimer(gameId: string) {
    this.clearTimer(gameId);
    this.timers.set(
      gameId,
      setTimeout(() => {
        void this.onTurnTimeout(gameId);
      }, TURN_SECONDS * 1000),
    );
  }

  private async onTurnTimeout(gameId: string) {
    const game = await this.model.findById(gameId).exec();
    if (!game || game.status !== CaroStatus.ACTIVE) return;
    // The player whose turn it is loses on timeout.
    const loserMark = game.turn;
    const loserId =
      loserMark === 1 ? game.playerX.toString() : game.playerO.toString();
    const winner = this.opponentOf(game, loserId);
    await this.finish(game, winner, CaroEndReason.TIMEOUT);
  }

  private clearTimer(gameId: string) {
    const t = this.timers.get(gameId);
    if (t) clearTimeout(t);
    this.timers.delete(gameId);
  }

  private clearDcTimer(key: string) {
    const t = this.dcTimers.get(key);
    if (t) clearTimeout(t);
    this.dcTimers.delete(key);
  }

  // ── Finishing + RP / coins ────────────────────────────────────
  private async finish(
    game: CaroGameDocument,
    winnerId: string,
    reason: CaroEndReason,
  ): Promise<void> {
    this.clearTimer(game._id.toString());
    const loserId = this.opponentOf(game, winnerId);
    game.status = CaroStatus.FINISHED;
    game.winner = new Types.ObjectId(winnerId);
    game.endReason = reason;
    game.endedAt = new Date();

    let rpChange: Record<string, number> | undefined;
    if (game.mode === GameMode.RANKED) {
      const [winnerUser, loserUser] = await Promise.all([
        this.users.findById(winnerId),
        this.users.findById(loserId),
      ]);
      const { winnerDelta, loserDelta } = rankedOutcome(
        winnerUser?.rankPoints ?? 0,
        loserUser?.rankPoints ?? 0,
      );
      rpChange = { [winnerId]: winnerDelta, [loserId]: loserDelta };
      game.rpChange = rpChange;
      await Promise.all([
        this.leveling.addRankPoints(winnerId, winnerDelta, 'caro_win'),
        this.leveling.addRankPoints(loserId, loserDelta, 'caro_loss'),
      ]);
    } else if (game.mode === GameMode.WAGER && game.pot > 0) {
      // Winner takes the whole pot (both stakes already escrowed at start).
      await this.wager
        .payout(winnerId, game.pot, `caro:${game._id.toString()}`)
        .catch((e) =>
          this.logger.warn(`caro payout failed: ${(e as Error).message}`),
        );
    }
    await game.save();
    const view = await this.publicView(game);
    this.broadcast(game._id.toString(), 'caro:end', view);
    if (game.roomId) {
      await this.rooms.close(game.roomId.toString()).catch(() => undefined);
    }
  }

  private async finishDraw(game: CaroGameDocument): Promise<void> {
    this.clearTimer(game._id.toString());
    const xId = game.playerX.toString();
    const oId = game.playerO.toString();
    game.status = CaroStatus.FINISHED;
    game.endReason = CaroEndReason.DRAW;
    game.endedAt = new Date();
    if (game.mode === GameMode.RANKED) {
      const [xu, ou] = await Promise.all([
        this.users.findById(xId),
        this.users.findById(oId),
      ]);
      const [dx, do_] = drawOutcome(xu?.rankPoints ?? 0, ou?.rankPoints ?? 0);
      game.rpChange = { [xId]: dx, [oId]: do_ };
      await Promise.all([
        this.leveling.addRankPoints(xId, dx, 'caro_draw'),
        this.leveling.addRankPoints(oId, do_, 'caro_draw'),
      ]);
    } else if (game.mode === GameMode.WAGER && game.pot > 0) {
      // Refund each player their own stake on a draw.
      await Promise.all([
        this.wager
          .refund(xId, game.betAmount, `caro:${game._id.toString()}`)
          .catch(() => undefined),
        this.wager
          .refund(oId, game.betAmount, `caro:${game._id.toString()}`)
          .catch(() => undefined),
      ]);
    }
    await game.save();
    const view = await this.publicView(game);
    this.broadcast(game._id.toString(), 'caro:end', view);
    if (game.roomId) {
      await this.rooms.close(game.roomId.toString()).catch(() => undefined);
    }
  }

  private broadcast(gameId: string, event: string, payload: unknown) {
    this.realtime.emitToCaroRoom(gameId, event, payload);
  }

  // ── History ───────────────────────────────────────────────────
  async myActiveGame(userId: string): Promise<any | null> {
    const uid = new Types.ObjectId(userId);
    const game = await this.model
      .findOne({
        status: CaroStatus.ACTIVE,
        $or: [{ playerX: uid }, { playerO: uid }],
      })
      .sort({ _id: -1 })
      .exec();
    return game ? this.publicView(game) : null;
  }

  async history(userId: string, limit = 20): Promise<any[]> {
    const uid = new Types.ObjectId(userId);
    const games = await this.model
      .find({
        status: CaroStatus.FINISHED,
        $or: [{ playerX: uid }, { playerO: uid }],
      })
      .sort({ _id: -1 })
      .limit(Math.min(limit, 50))
      .exec();
    return Promise.all(games.map((g) => this.publicView(g)));
  }
}

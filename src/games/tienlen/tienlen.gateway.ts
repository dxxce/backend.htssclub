import { Logger, UseGuards, UseFilters } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { WsJwtGuard } from '../../common/guards/ws-jwt.guard';
import { WsExceptionsFilter } from '../../common/filters/ws-exceptions.filter';
import { AuthUser } from '../../common/types/jwt-payload';
import { AuthService } from '../../auth/auth.service';
import { UsersService } from '../../users/users.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { GameMode, GameType } from '../../common/enums';
import { RoomsService } from '../common/rooms.service';
import { ChallengeService } from '../common/challenge.service';
import { WagerService } from '../common/wager.service';
import { TienLenService } from './tienlen.service';
import { TienLenMatchmakingService } from './tienlen-matchmaking.service';

interface PlayPayload {
  gameId: string;
  cards: number[];
}
interface GamePayload {
  gameId: string;
}
interface RoomPayload {
  roomId: string;
}

const LOBBY_ROOM = 'tienlen:lobby';

/**
 * Tiến Lên Miền Nam gateway on namespace `/ws-tienlen`. Handles matchmaking
 * (per table size, with live counts), coin-wager rooms, gameplay (play/pass),
 * resignation and reconnection.
 */
@WebSocketGateway({ namespace: '/ws-tienlen', cors: true })
@UseFilters(WsExceptionsFilter)
export class TienLenGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(TienLenGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly tienlen: TienLenService,
    private readonly matchmaking: TienLenMatchmakingService,
    private readonly realtime: RealtimeService,
    private readonly rooms: RoomsService,
    private readonly users: UsersService,
    private readonly challenges: ChallengeService,
    private readonly wager: WagerService,
  ) {}

  afterInit(server: Server) {
    this.realtime.setTienLenServer(server);
    this.logger.log('Tiến Lên gateway initialized on /ws-tienlen');
  }

  async handleConnection(client: Socket) {
    const user = await WsJwtGuard.authenticate(client, this.auth);
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Invalid token' });
      client.disconnect(true);
      return;
    }
    client.data.user = user;
    client.join(`tienlen-user:${user.id}`);
  }

  async handleDisconnect(client: Socket) {
    const user: AuthUser | undefined = client.data?.user;
    if (!user) return;
    const wasQueued = await this.matchmaking
      .isQueued(user.id)
      .catch(() => false);
    await this.matchmaking.dequeue(user.id).catch(() => undefined);
    if (wasQueued) await this.broadcastCounts();
    const gameId: string | undefined = client.data?.tlGameId;
    if (gameId) {
      await this.tienlen.onDisconnect(gameId, user.id).catch(() => undefined);
    }
  }

  // ── Lobby live counts ─────────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:lobby:join')
  async onLobbyJoin(@ConnectedSocket() client: Socket) {
    client.join(LOBBY_ROOM);
    return {
      searching: await this.matchmaking.counts(),
      players: await this.queuedPlayers(),
    };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:lobby:leave')
  async onLobbyLeave(@ConnectedSocket() client: Socket) {
    client.leave(LOBBY_ROOM);
    return { left: true };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:queue:count')
  async onQueueCount() {
    return {
      searching: await this.matchmaking.counts(),
      players: await this.queuedPlayers(),
    };
  }

  /** Queued players per table size, enriched with identity + rank cards. */
  private async queuedPlayers(): Promise<Record<number, any[]>> {
    const queued = await this.matchmaking.listQueued();
    const allIds = [
      ...new Set([...queued[2], ...queued[3], ...queued[4]]),
    ];
    const cards = await this.users.getCards(allIds);
    const enrich = (ids: string[]) =>
      ids.map((id) => ({
        userId: id,
        user: cards.get(id) ?? { id, username: 'unknown' },
      }));
    return { 2: enrich(queued[2]), 3: enrich(queued[3]), 4: enrich(queued[4]) };
  }

  private async broadcastCounts(): Promise<void> {
    const [searching, players] = await Promise.all([
      this.matchmaking.counts(),
      this.queuedPlayers(),
    ]);
    this.server.to(LOBBY_ROOM).emit('tienlen:queue:count', { searching, players });
  }

  // ── Direct challenge (invite -> accept/decline), 1v1 ──────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:challenge')
  async onChallenge(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { opponentId: string; ranked?: boolean; betAmount?: number },
  ) {
    const user = this.userOf(client);
    if (!body?.opponentId || body.opponentId === user.id) {
      throw new WsException('Invalid opponent');
    }
    await this.users.findByIdOrThrow(body.opponentId);
    const betAmount = Math.floor(body?.betAmount ?? 0);
    const mode = body.ranked
      ? GameMode.RANKED
      : betAmount > 0
        ? GameMode.WAGER
        : GameMode.CASUAL;
    const challenge = await this.challenges.create(
      GameType.TIENLEN,
      user.id,
      body.opponentId,
      mode,
      betAmount,
    );
    const cards = await this.users.getCards([user.id]);
    this.realtime.emitToTienLenUser(body.opponentId, 'tienlen:challenge-received', {
      challengeId: challenge.id,
      from: cards.get(user.id) ?? { id: user.id, username: user.username },
      mode,
      betAmount,
      expiresInMs: 45000,
    });
    return { challengeId: challenge.id, sent: true, expiresInMs: 45000 };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:challenge:accept')
  async onChallengeAccept(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { challengeId: string },
  ) {
    const user = this.userOf(client);
    const challenge = await this.challenges.claim(body?.challengeId);
    if (!challenge || challenge.game !== GameType.TIENLEN) {
      throw new WsException('Challenge expired or not found');
    }
    if (challenge.toUserId !== user.id) {
      throw new WsException('This challenge is not addressed to you');
    }
    // WAGER challenges: collect both stakes before starting.
    if (challenge.mode === GameMode.WAGER && challenge.betAmount > 0) {
      const ref = `tienlen-challenge:${challenge.id}`;
      const okFrom = await this.wager
        .collectStake(challenge.fromUserId, challenge.betAmount, ref)
        .then(() => true)
        .catch(() => false);
      const okTo = okFrom
        ? await this.wager
            .collectStake(challenge.toUserId, challenge.betAmount, ref)
            .then(() => true)
            .catch(() => false)
        : false;
      if (!okFrom || !okTo) {
        // Refund whoever was charged, then bail.
        const charged: string[] = [];
        if (okFrom) charged.push(challenge.fromUserId);
        if (okTo) charged.push(challenge.toUserId);
        await this.wager.refundMany(charged, challenge.betAmount, ref);
        throw new WsException('Both players need enough coins for the bet');
      }
    }
    const game = await this.tienlen.createGame(
      [challenge.fromUserId, challenge.toUserId],
      { mode: challenge.mode, betAmount: challenge.betAmount },
    );
    const gameId = game._id.toString();
    this.realtime.emitToTienLenUser(challenge.fromUserId, 'tienlen:challenge-accepted', {
      challengeId: challenge.id,
      gameId,
      byUserId: user.id,
    });
    return { gameId };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:challenge:decline')
  async onChallengeDecline(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { challengeId: string },
  ) {
    const user = this.userOf(client);
    const challenge = await this.challenges.get(body?.challengeId);
    if (!challenge) return { ok: true };
    if (challenge.toUserId !== user.id) {
      throw new WsException('This challenge is not addressed to you');
    }
    await this.challenges.remove(challenge.id);
    this.realtime.emitToTienLenUser(challenge.fromUserId, 'tienlen:challenge-declined', {
      challengeId: challenge.id,
      byUserId: user.id,
    });
    return { declined: true };
  }

  // ── Matchmaking (ranked) ──────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:queue:join')
  async onQueueJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { size?: number },
  ) {
    const user = this.userOf(client);
    const size = [2, 3, 4].includes(body?.size ?? 0) ? body!.size! : 4;
    await this.matchmaking.enqueue(size, user.id, client.id);
    client.join(LOBBY_ROOM);

    const matched = await this.matchmaking.tryMatch(size);
    if (!matched) {
      await this.broadcastCounts();
      return {
        queued: true,
        size,
        searching: await this.matchmaking.counts(),
      };
    }
    const game = await this.tienlen.createGame(matched, {
      mode: GameMode.RANKED,
    });
    await this.broadcastCounts();
    return { matched: true, gameId: game._id.toString() };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:queue:leave')
  async onQueueLeave(@ConnectedSocket() client: Socket) {
    const user = this.userOf(client);
    await this.matchmaking.dequeue(user.id);
    await this.broadcastCounts();
    return { left: true, searching: await this.matchmaking.counts() };
  }

  // ── Coin-wager / custom rooms (2..4 players) ──────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:room:create')
  async onRoomCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: {
      betAmount?: number;
      maxPlayers?: number;
      ranked?: boolean;
      isPrivate?: boolean;
      name?: string;
    },
  ) {
    const user = this.userOf(client);
    const maxPlayers = [2, 3, 4].includes(body?.maxPlayers ?? 0)
      ? body!.maxPlayers!
      : 4;
    const betAmount = Math.floor(body?.betAmount ?? 0);
    const mode = body?.ranked
      ? GameMode.RANKED
      : betAmount > 0
        ? GameMode.WAGER
        : GameMode.CASUAL;
    const room = await this.rooms.create(user.id, {
      game: GameType.TIENLEN,
      mode,
      betAmount,
      minPlayers: 2,
      maxPlayers,
      name: body?.name,
      isPrivate: body?.isPrivate ?? false,
    });
    client.join(`tienlen-room:${room._id.toString()}`);
    return this.rooms.publicView(room);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:room:join')
  async onRoomJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: RoomPayload & { code?: string },
  ) {
    const user = this.userOf(client);
    const room = body?.roomId
      ? await this.rooms.getOrThrow(body.roomId)
      : await this.rooms.getByCode(body.code ?? '');
    const updated = await this.rooms.join(room._id.toString(), user.id);
    const roomId = updated._id.toString();
    client.join(`tienlen-room:${roomId}`);
    const view = await this.rooms.publicView(updated);
    this.server.to(`tienlen-room:${roomId}`).emit('tienlen:room:updated', view);
    return view;
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:room:leave')
  async onRoomLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: RoomPayload,
  ) {
    const user = this.userOf(client);
    const { room, cancelled } = await this.rooms.leave(body.roomId, user.id);
    const roomId = body.roomId;
    if (cancelled) {
      this.server
        .to(`tienlen-room:${roomId}`)
        .emit('tienlen:room:closed', { roomId, reason: 'HOST_LEFT' });
    } else if (room) {
      this.server
        .to(`tienlen-room:${roomId}`)
        .emit('tienlen:room:updated', await this.rooms.publicView(room));
    }
    client.leave(`tienlen-room:${roomId}`);
    return { left: roomId, cancelled };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:room:ready')
  async onRoomReady(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: RoomPayload & { ready: boolean },
  ) {
    const user = this.userOf(client);
    const room = await this.rooms.setReady(body.roomId, user.id, !!body.ready);
    const view = await this.rooms.publicView(room);
    this.server
      .to(`tienlen-room:${body.roomId}`)
      .emit('tienlen:room:updated', view);
    return view;
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:room:start')
  async onRoomStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: RoomPayload,
  ) {
    const user = this.userOf(client);
    const room = await this.rooms.beginStart(body.roomId, user.id);
    try {
      const game = await this.tienlen.launchFromRoom({
        id: room._id.toString(),
        mode: room.mode,
        betAmount: room.betAmount,
        memberIds: room.members.map((m) => m.userId.toString()),
      });
      const gameId = game._id.toString();
      this.server
        .to(`tienlen-room:${body.roomId}`)
        .emit('tienlen:room:started', { roomId: body.roomId, gameId });
      return { gameId };
    } catch (e) {
      await this.rooms.revertToWaiting(body.roomId).catch(() => undefined);
      throw new WsException((e as Error).message || 'Failed to start game');
    }
  }

  // ── In-game ───────────────────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:join')
  async onJoinGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: GamePayload,
  ) {
    const user = this.userOf(client);
    const game = await this.tienlen.getGameOrThrow(body.gameId);
    client.join(`tienlen:${body.gameId}`);
    client.data.tlGameId = body.gameId;
    await this.tienlen.onReconnect(body.gameId, user.id);
    return this.tienlen.publicView(game, user.id);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:leave')
  async onLeaveGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: GamePayload,
  ) {
    client.leave(`tienlen:${body.gameId}`);
    if (client.data?.tlGameId === body.gameId) {
      client.data.tlGameId = undefined;
    }
    return { left: body.gameId };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:play')
  async onPlay(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: PlayPayload,
  ) {
    const user = this.userOf(client);
    return this.tienlen.play(body.gameId, user.id, body.cards);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:pass')
  async onPass(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: GamePayload,
  ) {
    const user = this.userOf(client);
    return this.tienlen.pass(body.gameId, user.id);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('tienlen:resign')
  async onResign(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: GamePayload,
  ) {
    const user = this.userOf(client);
    return this.tienlen.resign(body.gameId, user.id);
  }

  private userOf(client: Socket): AuthUser {
    const user = client.data?.user as AuthUser | undefined;
    if (!user) throw new WsException('Unauthorized');
    return user;
  }
}

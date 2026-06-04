import { Logger, UseGuards } from '@nestjs/common';
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
import { AuthUser } from '../../common/types/jwt-payload';
import { AuthService } from '../../auth/auth.service';
import { UsersService } from '../../users/users.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { GameMode, GameType } from '../../common/enums';
import { RoomsService } from '../common/rooms.service';
import { ChallengeService } from '../common/challenge.service';
import { CaroService } from './caro.service';
import { CaroMatchmakingService } from './caro-matchmaking.service';

interface MovePayload {
  gameId: string;
  row: number;
  col: number;
}
interface GamePayload {
  gameId: string;
}
interface RoomPayload {
  roomId: string;
}

// Lobby room: clients browsing the Caro menu join this to receive live
// matchmaking queue counts without entering the queue themselves.
const LOBBY_ROOM = 'caro:lobby';

/**
 * Caro 1v1 gateway on namespace `/ws-caro`. Handles matchmaking (with live
 * queue counts), coin-wager rooms, joining a game room (live updates +
 * reconnection), moves and resignation.
 */
@WebSocketGateway({ namespace: '/ws-caro', cors: true })
export class CaroGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(CaroGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly caro: CaroService,
    private readonly matchmaking: CaroMatchmakingService,
    private readonly realtime: RealtimeService,
    private readonly rooms: RoomsService,
    private readonly challenges: ChallengeService,
  ) {}

  afterInit(server: Server) {
    this.realtime.setCaroServer(server);
    this.logger.log('Caro gateway initialized on /ws-caro');
  }

  async handleConnection(client: Socket) {
    const user = await WsJwtGuard.authenticate(client, this.auth);
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Invalid token' });
      client.disconnect(true);
      return;
    }
    client.data.user = user;
    client.join(`caro-user:${user.id}`);
  }

  async handleDisconnect(client: Socket) {
    const user: AuthUser | undefined = client.data?.user;
    if (!user) return;
    // Leave matchmaking if queued, then refresh the live count.
    const wasQueued = await this.matchmaking
      .isQueued(user.id)
      .catch(() => false);
    await this.matchmaking.dequeue(user.id).catch(() => undefined);
    if (wasQueued) await this.broadcastQueueCount();
    // If this socket was watching a game room, flag disconnect for forfeit.
    const gameId: string | undefined = client.data?.caroGameId;
    if (gameId) {
      await this.caro.onDisconnect(gameId, user.id).catch(() => undefined);
    }
  }

  // ── Lobby live count ──────────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:lobby:join')
  async onLobbyJoin(@ConnectedSocket() client: Socket) {
    client.join(LOBBY_ROOM);
    return {
      searching: await this.matchmaking.size(),
      players: await this.queuedPlayers(),
    };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:lobby:leave')
  async onLobbyLeave(@ConnectedSocket() client: Socket) {
    client.leave(LOBBY_ROOM);
    return { left: true };
  }

  /** Enriches queued userIds with identity + rank cards for display. */
  private async queuedPlayers(): Promise<any[]> {
    const queued = await this.matchmaking.listQueued();
    if (!queued.length) return [];
    const cards = await this.users.getCards(queued.map((q) => q.userId));
    return queued.map((q) => ({
      userId: q.userId,
      rankPoints: q.rp,
      user: cards.get(q.userId) ?? { id: q.userId, username: 'unknown' },
    }));
  }

  /** Emits the current matchmaking queue size + player cards to the lobby. */
  private async broadcastQueueCount(): Promise<void> {
    const [searching, players] = await Promise.all([
      this.matchmaking.size(),
      this.queuedPlayers(),
    ]);
    this.server.to(LOBBY_ROOM).emit('caro:queue:count', { searching, players });
  }

  // ── Matchmaking ───────────────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:queue:join')
  async onQueueJoin(@ConnectedSocket() client: Socket) {
    const user = this.userOf(client);
    const profile = await this.users.findById(user.id);
    const rp = profile?.rankPoints ?? 0;
    await this.matchmaking.enqueue(user.id, rp, client.id);
    client.join(LOBBY_ROOM); // queued players also get live counts

    const opp = await this.matchmaking.tryMatch(user.id);
    if (!opp) {
      await this.broadcastQueueCount();
      const size = await this.matchmaking.size();
      return {
        queued: true,
        queueSize: size,
        searching: size,
        players: await this.queuedPlayers(),
      };
    }
    // Matched! Randomize who goes first (X). Quick-match is always RANKED.
    const [xId, oId] =
      Math.random() < 0.5 ? [user.id, opp.userId] : [opp.userId, user.id];
    const game = await this.caro.createGame(xId, oId, {
      mode: GameMode.RANKED,
    });
    await this.broadcastQueueCount();
    return { matched: true, gameId: game._id.toString() };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:queue:leave')
  async onQueueLeave(@ConnectedSocket() client: Socket) {
    const user = this.userOf(client);
    await this.matchmaking.dequeue(user.id);
    await this.broadcastQueueCount();
    return { left: true, searching: await this.matchmaking.size() };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:queue:count')
  async onQueueCount() {
    return {
      searching: await this.matchmaking.size(),
      players: await this.queuedPlayers(),
    };
  }

  // ── Direct challenge (invite -> accept/decline) ───────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:challenge')
  async onChallenge(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { opponentId: string; ranked?: boolean },
  ) {
    const user = this.userOf(client);
    if (!body?.opponentId || body.opponentId === user.id) {
      throw new WsException('Invalid opponent');
    }
    await this.users.findByIdOrThrow(body.opponentId);
    const mode = body.ranked ? GameMode.RANKED : GameMode.CASUAL;
    const challenge = await this.challenges.create(
      GameType.CARO,
      user.id,
      body.opponentId,
      mode,
      0,
    );
    // Notify the invitee with the challenger's card.
    const cards = await this.users.getCards([user.id]);
    this.realtime.emitToCaroUser(body.opponentId, 'caro:challenge-received', {
      challengeId: challenge.id,
      from: cards.get(user.id) ?? { id: user.id, username: user.username },
      mode,
      ranked: mode === GameMode.RANKED,
      expiresInMs: 45000,
    });
    return { challengeId: challenge.id, sent: true, expiresInMs: 45000 };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:challenge:accept')
  async onChallengeAccept(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { challengeId: string },
  ) {
    const user = this.userOf(client);
    const challenge = await this.challenges.claim(body?.challengeId);
    if (!challenge || challenge.game !== GameType.CARO) {
      throw new WsException('Challenge expired or not found');
    }
    if (challenge.toUserId !== user.id) {
      throw new WsException('This challenge is not addressed to you');
    }
    // Randomize who goes first.
    const [xId, oId] =
      Math.random() < 0.5
        ? [challenge.fromUserId, challenge.toUserId]
        : [challenge.toUserId, challenge.fromUserId];
    const game = await this.caro.createGame(xId, oId, { mode: challenge.mode });
    const gameId = game._id.toString();
    // Tell the challenger it was accepted (they also get caro:matched).
    this.realtime.emitToCaroUser(challenge.fromUserId, 'caro:challenge-accepted', {
      challengeId: challenge.id,
      gameId,
      byUserId: user.id,
    });
    return { gameId };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:challenge:decline')
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
    this.realtime.emitToCaroUser(challenge.fromUserId, 'caro:challenge-declined', {
      challengeId: challenge.id,
      byUserId: user.id,
    });
    return { declined: true };
  }

  // ── Coin-wager / custom rooms ─────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:room:create')
  async onRoomCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: { betAmount?: number; isPrivate?: boolean; name?: string },
  ) {
    const user = this.userOf(client);
    const betAmount = Math.floor(body?.betAmount ?? 0);
    const room = await this.rooms.create(user.id, {
      game: GameType.CARO,
      mode: betAmount > 0 ? GameMode.WAGER : GameMode.CASUAL,
      betAmount,
      minPlayers: 2,
      maxPlayers: 2,
      name: body?.name,
      isPrivate: body?.isPrivate ?? false,
    });
    client.join(`caro-room:${room._id.toString()}`);
    const view = await this.rooms.publicView(room);
    return view;
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:room:join')
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
    client.join(`caro-room:${roomId}`);
    const view = await this.rooms.publicView(updated);
    this.server.to(`caro-room:${roomId}`).emit('caro:room:updated', view);
    return view;
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:room:leave')
  async onRoomLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: RoomPayload,
  ) {
    const user = this.userOf(client);
    const { room, cancelled } = await this.rooms.leave(body.roomId, user.id);
    const roomId = body.roomId;
    if (cancelled) {
      this.server
        .to(`caro-room:${roomId}`)
        .emit('caro:room:closed', { roomId, reason: 'HOST_LEFT' });
    } else if (room) {
      this.server
        .to(`caro-room:${roomId}`)
        .emit('caro:room:updated', await this.rooms.publicView(room));
    }
    client.leave(`caro-room:${roomId}`);
    return { left: roomId, cancelled };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:room:ready')
  async onRoomReady(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: RoomPayload & { ready: boolean },
  ) {
    const user = this.userOf(client);
    const room = await this.rooms.setReady(body.roomId, user.id, !!body.ready);
    const view = await this.rooms.publicView(room);
    this.server.to(`caro-room:${body.roomId}`).emit('caro:room:updated', view);
    return view;
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:room:start')
  async onRoomStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: RoomPayload,
  ) {
    const user = this.userOf(client);
    const room = await this.rooms.beginStart(body.roomId, user.id);
    try {
      const game = await this.caro.launchFromRoom({
        id: room._id.toString(),
        mode: room.mode,
        betAmount: room.betAmount,
        memberIds: room.members.map((m) => m.userId.toString()),
      });
      const gameId = game._id.toString();
      this.server
        .to(`caro-room:${body.roomId}`)
        .emit('caro:room:started', { roomId: body.roomId, gameId });
      return { gameId };
    } catch (e) {
      // Launching failed — roll the room back so players can retry.
      await this.rooms.revertToWaiting(body.roomId).catch(() => undefined);
      throw new WsException((e as Error).message || 'Failed to start game');
    }
  }

  // ── In-game ───────────────────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:join')
  async onJoinGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: GamePayload,
  ) {
    const user = this.userOf(client);
    const game = await this.caro.getGameOrThrow(body.gameId);
    client.join(`caro:${body.gameId}`);
    client.data.caroGameId = body.gameId;
    await this.caro.onReconnect(body.gameId, user.id);
    // Return the full current state so the client can render immediately.
    return this.caro.publicView(game);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:leave')
  async onLeaveGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: GamePayload,
  ) {
    client.leave(`caro:${body.gameId}`);
    if (client.data?.caroGameId === body.gameId) {
      client.data.caroGameId = undefined;
    }
    return { left: body.gameId };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:move')
  async onMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: MovePayload,
  ) {
    const user = this.userOf(client);
    return this.caro.move(body.gameId, user.id, body.row, body.col);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:resign')
  async onResign(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: GamePayload,
  ) {
    const user = this.userOf(client);
    return this.caro.resign(body.gameId, user.id);
  }

  private userOf(client: Socket): AuthUser {
    const user = client.data?.user as AuthUser | undefined;
    if (!user) throw new WsException('Unauthorized');
    return user;
  }
}

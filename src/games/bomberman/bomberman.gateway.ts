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
import { BombermanService } from './bomberman.service';
import { BombermanMatchmakingService } from './bomberman-matchmaking.service';

interface GamePayload {
  gameId: string;
}
interface RoomPayload {
  roomId: string;
}

const LOBBY_ROOM = 'bomberman:lobby';

/**
 * Bomberman gateway on `/ws-bomberman`. Matchmaking by table size (2-4),
 * coin-wager rooms with map choice, direct challenge invites, and realtime
 * input (move direction + place bomb) forwarded to the authoritative engine.
 */
@WebSocketGateway({ namespace: '/ws-bomberman', cors: true })
@UseFilters(WsExceptionsFilter)
export class BombermanGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(BombermanGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly bomberman: BombermanService,
    private readonly matchmaking: BombermanMatchmakingService,
    private readonly realtime: RealtimeService,
    private readonly rooms: RoomsService,
    private readonly challenges: ChallengeService,
  ) {}

  afterInit(server: Server) {
    this.realtime.setBombermanServer(server);
    this.logger.log('Bomberman gateway initialized on /ws-bomberman');
  }

  async handleConnection(client: Socket) {
    const user = await WsJwtGuard.authenticate(client, this.auth);
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Invalid token' });
      client.disconnect(true);
      return;
    }
    client.data.user = user;
    client.join(`bomberman-user:${user.id}`);
  }

  async handleDisconnect(client: Socket) {
    const user: AuthUser | undefined = client.data?.user;
    if (!user) return;
    const wasQueued = await this.matchmaking.isQueued(user.id).catch(() => false);
    await this.matchmaking.dequeue(user.id).catch(() => undefined);
    if (wasQueued) await this.broadcastCounts();
    const gameId: string | undefined = client.data?.bmGameId;
    if (gameId) {
      // Leaving mid-match kills the player so the round can resolve.
      this.bomberman.killPlayer(gameId, user.id);
    }
  }

  // ── Lobby counts ──────────────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:lobby:join')
  async onLobbyJoin(@ConnectedSocket() client: Socket) {
    client.join(LOBBY_ROOM);
    return { searching: await this.matchmaking.counts(), players: await this.queuedPlayers() };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:lobby:leave')
  async onLobbyLeave(@ConnectedSocket() client: Socket) {
    client.leave(LOBBY_ROOM);
    return { left: true };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:queue:count')
  async onQueueCount() {
    return { searching: await this.matchmaking.counts(), players: await this.queuedPlayers() };
  }

  private async queuedPlayers(): Promise<Record<string, any[]>> {
    const bySize = await this.matchmaking.listBySize();
    const allIds = new Set<string>();
    Object.values(bySize).forEach((list) => list.forEach((q) => allIds.add(q.userId)));
    const cards = await this.users.getCards([...allIds]);
    const out: Record<string, any[]> = {};
    for (const [size, list] of Object.entries(bySize)) {
      out[size] = list.map((q) => ({
        userId: q.userId,
        rankPoints: q.rp,
        user: cards.get(q.userId) ?? { id: q.userId, username: 'unknown' },
      }));
    }
    return out;
  }

  private async broadcastCounts(): Promise<void> {
    const [searching, players] = await Promise.all([
      this.matchmaking.counts(),
      this.queuedPlayers(),
    ]);
    this.server.to(LOBBY_ROOM).emit('bomberman:queue:count', { searching, players });
  }

  // ── Matchmaking ───────────────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:queue:join')
  async onQueueJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { size?: number },
  ) {
    const user = this.userOf(client);
    const size = [2, 3, 4].includes(Number(body?.size)) ? Number(body.size) : 2;
    const profile = await this.users.findById(user.id);
    await this.matchmaking.enqueue(user.id, size, profile?.rankPoints ?? 0, client.id);
    client.join(LOBBY_ROOM);

    const matched = await this.matchmaking.tryMatch(user.id, size);
    if (!matched) {
      await this.broadcastCounts();
      return {
        queued: true,
        size,
        searching: await this.matchmaking.counts(),
        players: await this.queuedPlayers(),
      };
    }
    // shuffle seating order
    const ids = [...matched].sort(() => Math.random() - 0.5);
    const game = await this.bomberman.createGame(ids, { mode: GameMode.RANKED });
    await this.broadcastCounts();
    return { matched: true, gameId: game._id.toString() };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:queue:leave')
  async onQueueLeave(@ConnectedSocket() client: Socket) {
    const user = this.userOf(client);
    await this.matchmaking.dequeue(user.id);
    await this.broadcastCounts();
    return { left: true, searching: await this.matchmaking.counts() };
  }

  // ── Direct challenge (invite -> accept/decline) ───────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:challenge')
  async onChallenge(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { opponentId: string; ranked?: boolean },
  ) {
    const user = this.userOf(client);
    if (!body?.opponentId || body.opponentId === user.id) {
      throw new WsException('Invalid opponent');
    }
    await this.users.findByIdOrThrow(body.opponentId);
    const mode = body.ranked === false ? GameMode.CASUAL : GameMode.RANKED;
    const challenge = await this.challenges.create(
      GameType.BOMBERMAN,
      user.id,
      body.opponentId,
      mode,
      0,
    );
    const cards = await this.users.getCards([user.id]);
    this.realtime.emitToBombermanUser(body.opponentId, 'bomberman:challenge-received', {
      challengeId: challenge.id,
      from: cards.get(user.id) ?? { id: user.id, username: user.username },
      mode,
      ranked: mode === GameMode.RANKED,
      expiresInMs: 45000,
    });
    return { challengeId: challenge.id, sent: true, expiresInMs: 45000 };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:challenge:accept')
  async onChallengeAccept(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { challengeId: string },
  ) {
    const user = this.userOf(client);
    const challenge = await this.challenges.claim(body?.challengeId);
    if (!challenge || challenge.game !== GameType.BOMBERMAN) {
      throw new WsException('Challenge expired or not found');
    }
    if (challenge.toUserId !== user.id) {
      throw new WsException('This challenge is not addressed to you');
    }
    const ids = [challenge.fromUserId, challenge.toUserId].sort(() => Math.random() - 0.5);
    const game = await this.bomberman.createGame(ids, { mode: challenge.mode });
    const gameId = game._id.toString();
    this.realtime.emitToBombermanUser(challenge.fromUserId, 'bomberman:challenge-accepted', {
      challengeId: challenge.id,
      gameId,
      byUserId: user.id,
    });
    return { gameId };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:challenge:decline')
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
    this.realtime.emitToBombermanUser(challenge.fromUserId, 'bomberman:challenge-declined', {
      challengeId: challenge.id,
      byUserId: user.id,
    });
    return { declined: true };
  }

  // ── Rooms (wager / custom, with map + size) ───────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:room:create')
  async onRoomCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: { betAmount?: number; maxPlayers?: number; mapId?: string; isPrivate?: boolean; name?: string },
  ) {
    const user = this.userOf(client);
    const betAmount = Math.floor(body?.betAmount ?? 0);
    const maxPlayers = [2, 3, 4].includes(Number(body?.maxPlayers)) ? Number(body.maxPlayers) : 4;
    const room = await this.rooms.create(user.id, {
      game: GameType.BOMBERMAN,
      mode: betAmount > 0 ? GameMode.WAGER : GameMode.CASUAL,
      betAmount,
      minPlayers: 2,
      maxPlayers,
      name: body?.name,
      isPrivate: body?.isPrivate ?? false,
    });
    // remember chosen map on the room doc via name hack? store in memory map instead.
    if (body?.mapId) this.roomMaps.set(room._id.toString(), body.mapId);
    client.join(`bomberman-room:${room._id.toString()}`);
    return this.rooms.publicView(room);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:room:join')
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
    client.join(`bomberman-room:${roomId}`);
    const view = await this.rooms.publicView(updated);
    this.server.to(`bomberman-room:${roomId}`).emit('bomberman:room:updated', view);
    return view;
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:room:leave')
  async onRoomLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: RoomPayload,
  ) {
    const user = this.userOf(client);
    const { room, cancelled } = await this.rooms.leave(body.roomId, user.id);
    const roomId = body.roomId;
    if (cancelled) {
      this.server.to(`bomberman-room:${roomId}`).emit('bomberman:room:closed', { roomId, reason: 'HOST_LEFT' });
      this.roomMaps.delete(roomId);
    } else if (room) {
      this.server.to(`bomberman-room:${roomId}`).emit('bomberman:room:updated', await this.rooms.publicView(room));
    }
    client.leave(`bomberman-room:${roomId}`);
    return { left: roomId, cancelled };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:room:ready')
  async onRoomReady(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: RoomPayload & { ready: boolean },
  ) {
    const user = this.userOf(client);
    const room = await this.rooms.setReady(body.roomId, user.id, !!body.ready);
    const view = await this.rooms.publicView(room);
    this.server.to(`bomberman-room:${body.roomId}`).emit('bomberman:room:updated', view);
    return view;
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:room:start')
  async onRoomStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: RoomPayload,
  ) {
    const user = this.userOf(client);
    const room = await this.rooms.beginStart(body.roomId, user.id);
    try {
      const game = await this.bomberman.launchFromRoom({
        id: room._id.toString(),
        mode: room.mode,
        betAmount: room.betAmount,
        memberIds: room.members.map((m) => m.userId.toString()),
        mapId: this.roomMaps.get(body.roomId),
      });
      const gameId = game._id.toString();
      this.server.to(`bomberman-room:${body.roomId}`).emit('bomberman:room:started', { roomId: body.roomId, gameId });
      this.roomMaps.delete(body.roomId);
      return { gameId };
    } catch (e) {
      await this.rooms.revertToWaiting(body.roomId).catch(() => undefined);
      throw new WsException((e as Error).message || 'Failed to start game');
    }
  }

  // ── In-game ───────────────────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:join')
  async onJoinGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: GamePayload,
  ) {
    client.join(`bomberman:${body.gameId}`);
    client.data.bmGameId = body.gameId;
    return this.bomberman.liveView(body.gameId);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:leave')
  async onLeaveGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: GamePayload,
  ) {
    const user = this.userOf(client);
    this.bomberman.killPlayer(body.gameId, user.id);
    client.leave(`bomberman:${body.gameId}`);
    if (client.data?.bmGameId === body.gameId) client.data.bmGameId = undefined;
    return { left: body.gameId };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:input')
  onInput(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { gameId: string; dx: number; dy: number },
  ) {
    const user = this.userOf(client);
    this.bomberman.setInput(body.gameId, user.id, body?.dx ?? 0, body?.dy ?? 0);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('bomberman:bomb')
  onBomb(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: GamePayload,
  ) {
    const user = this.userOf(client);
    this.bomberman.placeBomb(body.gameId, user.id);
  }

  // chosen map per pending room (kept in memory until the game launches)
  private roomMaps = new Map<string, string>();

  private userOf(client: Socket): AuthUser {
    const user = client.data?.user as AuthUser | undefined;
    if (!user) throw new WsException('Unauthorized');
    return user;
  }
}

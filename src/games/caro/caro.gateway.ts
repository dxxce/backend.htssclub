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

/**
 * Caro 1v1 gateway on namespace `/ws-caro`. Handles matchmaking, joining a
 * game room (for live updates + reconnection), moves and resignation.
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
    // Leave matchmaking if queued.
    await this.matchmaking.dequeue(user.id).catch(() => undefined);
    // If this socket was watching a game room, flag disconnect for forfeit.
    const gameId: string | undefined = client.data?.caroGameId;
    if (gameId) {
      await this.caro.onDisconnect(gameId, user.id).catch(() => undefined);
    }
  }

  // ── Matchmaking ───────────────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:queue:join')
  async onQueueJoin(@ConnectedSocket() client: Socket) {
    const user = this.userOf(client);
    const profile = await this.users.findById(user.id);
    const rp = profile?.rankPoints ?? 0;
    await this.matchmaking.enqueue(user.id, rp, client.id);

    const opp = await this.matchmaking.tryMatch(user.id);
    if (!opp) {
      const size = await this.matchmaking.size();
      return { queued: true, queueSize: size };
    }
    // Matched! Randomize who goes first (X).
    const [xId, oId] =
      Math.random() < 0.5 ? [user.id, opp.userId] : [opp.userId, user.id];
    const game = await this.caro.createGame(xId, oId, true);
    return { matched: true, gameId: game._id.toString() };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('caro:queue:leave')
  async onQueueLeave(@ConnectedSocket() client: Socket) {
    const user = this.userOf(client);
    await this.matchmaking.dequeue(user.id);
    return { left: true };
  }

  // ── Direct challenge a friend ─────────────────────────────────
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
    const [xId, oId] =
      Math.random() < 0.5
        ? [user.id, body.opponentId]
        : [body.opponentId, user.id];
    const game = await this.caro.createGame(xId, oId, body.ranked ?? false);
    return { gameId: game._id.toString() };
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

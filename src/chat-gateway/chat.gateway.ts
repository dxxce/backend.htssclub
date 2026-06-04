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
import { WsJwtGuard } from '../common/guards/ws-jwt.guard';
import { AuthUser } from '../common/types/jwt-payload';
import { PresenceStatus } from '../common/enums';
import { AuthService } from '../auth/auth.service';
import { ChannelsService } from '../channels/channels.service';
import { MessagesService } from '../messages/messages.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ServersService } from '../servers/servers.service';
import { UsersService } from '../users/users.service';
import { DmService } from '../dm/dm.service';
import {
  CreateMessageDto,
  UpdateMessageDto,
} from '../messages/dto/message.dto';
import { SendDmDto } from '../dm/dto/dm.dto';

interface ChannelRef {
  channelId: string;
}

@WebSocketGateway({ namespace: '/ws', cors: true })
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly servers: ServersService,
    private readonly channels: ChannelsService,
    private readonly messages: MessagesService,
    private readonly realtime: RealtimeService,
    private readonly dm: DmService,
  ) {}

  afterInit(server: Server) {
    // Expose the server to the realtime helper so other modules can emit.
    this.realtime.setServer(server);
    this.logger.log('Chat gateway initialized on /ws');
  }

  async handleConnection(client: Socket) {
    const user = await WsJwtGuard.authenticate(client, this.auth);
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Invalid token' });
      client.disconnect(true);
      return;
    }
    client.data.user = user;

    // Join personal + all server rooms.
    client.join(`user:${user.id}`);
    const serverIds = await this.servers.listServerIdsForUser(user.id);
    serverIds.forEach((sid) => client.join(`server:${sid}`));

    // Restore the user's chosen presence (e.g. IDLE/DND) instead of
    // forcing ONLINE, so a manual status set via REST is preserved.
    const presence = await this.users.goOnline(user.id);
    this.broadcastPresence(user.id, presence);
    this.logger.debug(`${user.username} connected (${client.id})`);
  }

  async handleDisconnect(client: Socket) {
    const user: AuthUser | undefined = client.data?.user;
    if (!user) return;
    // Only flip to OFFLINE if the user has no other live sockets.
    const room = this.server.in(`user:${user.id}`);
    const sockets = await room.fetchSockets();
    if (sockets.length === 0) {
      await this.users.goOffline(user.id);
      this.broadcastPresence(user.id, PresenceStatus.OFFLINE);
    }
    this.logger.debug(`${user.username} disconnected (${client.id})`);
  }

  // ── Channel rooms ─────────────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('channel:join')
  async onChannelJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChannelRef,
  ) {
    const user = this.userOf(client);
    await this.channels.assertAccess(body.channelId, user.id);
    client.join(`channel:${body.channelId}`);
    return { joined: body.channelId };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('channel:leave')
  async onChannelLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChannelRef,
  ) {
    client.leave(`channel:${body.channelId}`);
    return { left: body.channelId };
  }

  // ── Messages ──────────────────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('message:send')
  async onMessageSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: CreateMessageDto & ChannelRef,
  ) {
    const user = this.userOf(client);
    // Validation (content or attachments required) is enforced in the service.
    const message = await this.messages.create(body.channelId, user.id, {
      content: body.content,
      attachments: body.attachments,
      replyToId: body.replyToId,
    });
    return message;
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('message:edit')
  async onMessageEdit(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: UpdateMessageDto & { messageId: string },
  ) {
    const user = this.userOf(client);
    return this.messages.update(body.messageId, user.id, {
      content: body.content,
    });
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('message:delete')
  async onMessageDelete(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { messageId: string },
  ) {
    const user = this.userOf(client);
    return this.messages.remove(body.messageId, user.id);
  }

  // ── Typing indicators ─────────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('typing:start')
  onTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChannelRef,
  ) {
    const user = this.userOf(client);
    client.to(`channel:${body.channelId}`).emit('typing', {
      channelId: body.channelId,
      userId: user.id,
      isTyping: true,
    });
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('typing:stop')
  onTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChannelRef,
  ) {
    const user = this.userOf(client);
    client.to(`channel:${body.channelId}`).emit('typing', {
      channelId: body.channelId,
      userId: user.id,
      isTyping: false,
    });
  }

  // ── Presence ──────────────────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('presence:update')
  async onPresenceUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { status: PresenceStatus },
  ) {
    const user = this.userOf(client);
    await this.users.setPresence(user.id, body.status);
    this.broadcastPresence(user.id, body.status);
    return { presence: body.status };
  }

  // ── Direct messages (E2E) ─────────────────────────────────────
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('dm:send')
  async onDmSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: SendDmDto,
  ) {
    const user = this.userOf(client);
    // Server stores/forwards ciphertext only; it never sees plaintext.
    return this.dm.send(user.id, body);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('dm:typing:start')
  async onDmTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: string },
  ) {
    const user = this.userOf(client);
    return this.dm.typing(user.id, body.conversationId, true);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('dm:typing:stop')
  async onDmTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: string },
  ) {
    const user = this.userOf(client);
    return this.dm.typing(user.id, body.conversationId, false);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('dm:read')
  async onDmRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: string },
  ) {
    const user = this.userOf(client);
    return this.dm.markRead(user.id, body.conversationId);
  }

  // ── Helpers ───────────────────────────────────────────────────
  private userOf(client: Socket): AuthUser {
    const user = client.data?.user as AuthUser | undefined;
    if (!user) throw new WsException('Unauthorized');
    return user;
  }

  private broadcastPresence(userId: string, presence: PresenceStatus) {
    // Notify all servers the user belongs to.
    this.servers
      .listServerIdsForUser(userId)
      .then((serverIds) => {
        serverIds.forEach((sid) =>
          this.realtime.emitToServer(sid, 'presence:changed', {
            userId,
            presence,
          }),
        );
      })
      .catch(() => undefined);
  }
}

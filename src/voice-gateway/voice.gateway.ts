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
import { ChannelType } from '../common/enums';
import { AuthService } from '../auth/auth.service';
import { ChannelsService } from '../channels/channels.service';
import { RealtimeService } from '../realtime/realtime.service';
import { UsersService } from '../users/users.service';
import { SfuService } from './sfu.service';
import {
  VoiceMemberState,
  VoicePresenceService,
} from './voice-presence.service';

interface JoinPayload {
  channelId: string;
}
interface SignalPayload {
  toUserId: string;
  sdp?: any;
  candidate?: any;
}
interface StatePayload {
  muted?: boolean;
  deafened?: boolean;
  speaking?: boolean;
}

interface UserCard {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
}

interface VoiceMember {
  userId: string;
  user: UserCard;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
}

type VoiceMode = 'mesh' | 'sfu';

@WebSocketGateway({ namespace: '/ws-voice', cors: true })
export class VoiceGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(VoiceGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly channels: ChannelsService,
    private readonly presence: VoicePresenceService,
    private readonly users: UsersService,
    private readonly sfu: SfuService,
    private readonly realtime: RealtimeService,
  ) {}

  afterInit(server: Server) {
    // Expose the voice namespace so other modules (e.g. channel deletion)
    // can broadcast/kick voice participants.
    this.realtime.setVoiceServer(server);
    this.logger.log('Voice gateway initialized on /ws-voice');
  }

  async handleConnection(client: Socket) {
    const user = await this.authenticate(client);
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Invalid token' });
      client.disconnect(true);
      return;
    }
    // Enrich with profile info (displayName/avatarUrl) for voice member cards.
    const cards = await this.users.getCards([user.id]);
    const card = cards.get(user.id);
    if (card) {
      user.displayName = card.displayName;
      user.avatarUrl = card.avatarUrl;
    }
    client.data.user = user;
    // Personal room so peers can target this user directly (mesh signaling).
    client.join(`voice-user:${user.id}`);
    this.logger.debug(`voice connect: ${user.username} (${client.id})`);
  }

  async handleDisconnect(client: Socket) {
    const user: AuthUser | undefined = client.data?.user;
    if (!user) return;
    const channelId = await this.presence.getChannelOfUser(user.id);
    if (channelId) {
      await this.handleSocketLeave(channelId, user.id, client.id);
    }
    this.logger.debug(`voice disconnect: ${user.username} (${client.id})`);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('voice:join')
  async onJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: JoinPayload,
  ) {
    const user = this.userOf(client);
    const channelId = body?.channelId;
    if (!channelId) throw new WsException('channelId is required');

    const channel = await this.channels.assertAccess(channelId, user.id);
    if (channel.type !== ChannelType.VOICE) {
      throw new WsException('Channel is not a voice channel');
    }

    // If the socket was in another channel, leave it cleanly first.
    const previous = await this.presence.getChannelOfUser(user.id);
    if (previous && previous !== channelId) {
      await this.handleSocketLeave(previous, user.id, client.id);
      client.leave(`voice:${previous}`);
    }

    // Atomic join + userLimit enforcement (prevents races).
    const limit = channel.userLimit ?? 0;
    const { full, isNewMember, memberCount } = await this.presence.join(
      channelId,
      user.id,
      client.id,
      limit,
    );
    if (full) {
      throw new WsException('Voice channel is full');
    }

    // Join the room BEFORE broadcasting so to(room) reaches everyone.
    client.join(`voice:${channelId}`);

    const mode = this.resolveMode(memberCount);

    // Build the current member list (with user info + state).
    const members = await this.buildMembers(channelId);
    // Resolve the joiner's card from the member list (DB-backed) so it
    // always has displayName/avatarUrl, regardless of handshake timing.
    const meCard =
      members.find((m) => m.userId === user.id)?.user ??
      this.cardFromUser(user);

    // 1) Send the existing peers (everyone except me) ONLY to the joiner.
    const peers = members.filter((m) => m.userId !== user.id);
    client.emit('voice:peers', { channelId, peers });

    // 2) Notify the OTHERS in the room that a new member joined.
    if (isNewMember) {
      const member: VoiceMember = {
        userId: user.id,
        user: meCard,
        muted: false,
        deafened: false,
        speaking: false,
      };
      client
        .to(`voice:${channelId}`)
        .emit('voice:user-joined', { channelId, user: member });

      // Also notify the WHOLE server (chat namespace, room server:{id}) so
      // members browsing the server — but not inside the voice channel —
      // see the occupancy update in realtime.
      this.realtime.emitToServer(
        channel.serverId.toString(),
        'voice:channel-joined',
        { serverId: channel.serverId.toString(), channelId, member },
      );
    }

    // If SFU is enabled and the channel is large, announce mode + token.
    await this.maybeAnnounceModeSwitch(channelId, mode);
    if (mode === 'sfu') {
      const creds = await this.sfu.createToken(
        channelId,
        user.id,
        user.username,
      );
      if (creds) client.emit('voice:sfu', { channelId, ...creds });
    }

    // Ack payload (frontend may ignore it; the source of truth is the
    // voice:peers event above).
    return { channelId, mode, peers };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('voice:leave')
  async onLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: JoinPayload,
  ) {
    const user = this.userOf(client);
    const channelId = body?.channelId;
    if (!channelId) throw new WsException('channelId is required');
    client.leave(`voice:${channelId}`);
    await this.handleSocketLeave(channelId, user.id, client.id);
    return { left: channelId };
  }

  /**
   * Allows a client already in SFU mode to (re)fetch its LiveKit token.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('voice:sfu-token')
  async onSfuToken(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: JoinPayload,
  ) {
    const user = this.userOf(client);
    const channelId = await this.presence.getChannelOfUser(user.id);
    if (channelId !== body.channelId) {
      throw new WsException('Not in this voice channel');
    }
    const creds = await this.sfu.createToken(
      body.channelId,
      user.id,
      user.username,
    );
    if (!creds) throw new WsException('SFU not available');
    return creds;
  }

  // ── Mesh signaling: forward directly to the target user's socket ──
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('voice:offer')
  onOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: SignalPayload,
  ) {
    this.relay(client, body.toUserId, 'voice:offer', { sdp: body.sdp });
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('voice:answer')
  onAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: SignalPayload,
  ) {
    this.relay(client, body.toUserId, 'voice:answer', { sdp: body.sdp });
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('voice:ice')
  onIce(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: SignalPayload,
  ) {
    this.relay(client, body.toUserId, 'voice:ice', {
      candidate: body.candidate,
    });
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('voice:state')
  async onState(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: StatePayload,
  ) {
    const user = this.userOf(client);
    const channelId = await this.presence.getChannelOfUser(user.id);
    if (!channelId) return { ok: false };
    const prev = await this.presence.getState(channelId, user.id);
    const state: VoiceMemberState = {
      muted: body.muted ?? prev.muted,
      deafened: body.deafened ?? prev.deafened,
      speaking: body.speaking ?? prev.speaking,
    };
    await this.presence.setState(channelId, user.id, state);
    // Broadcast to the whole room (frontend ignores its own id).
    this.server.to(`voice:${channelId}`).emit('voice:state-changed', {
      userId: user.id,
      ...state,
    });
    return { ok: true };
  }

  // ── Helpers ───────────────────────────────────────────────────

  /** Builds the full VoiceMember[] for a channel (user card + state). */
  private async buildMembers(channelId: string): Promise<VoiceMember[]> {
    const withState = await this.presence.getMembersWithState(channelId);
    const cards = await this.users.getCards(withState.map((m) => m.userId));
    return withState.map((m) => ({
      userId: m.userId,
      user:
        cards.get(m.userId) ??
        { id: m.userId, username: 'unknown' },
      muted: m.state.muted,
      deafened: m.state.deafened,
      speaking: m.state.speaking,
    }));
  }

  private cardFromUser(user: AuthUser): UserCard {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
    };
  }

  private resolveMode(memberCount: number): VoiceMode {
    if (this.sfu.isEnabled() && memberCount >= this.sfu.threshold) {
      return 'sfu';
    }
    return 'mesh';
  }

  /**
   * Removes one socket. Only broadcasts `voice:user-left` when the user's
   * last socket leaves the channel (multi-tab / multi-device safe).
   */
  private async handleSocketLeave(
    channelId: string,
    userId: string,
    socketId: string,
  ): Promise<void> {
    const { removedMember } = await this.presence.removeSocket(
      channelId,
      userId,
      socketId,
    );
    if (removedMember) {
      this.server
        .to(`voice:${channelId}`)
        .emit('voice:user-left', { channelId, userId });

      // Also notify the whole server (chat namespace) so members browsing
      // the server list see the occupancy update in realtime.
      const serverId = await this.channels.getServerIdOfChannel(channelId);
      if (serverId) {
        this.realtime.emitToServer(serverId, 'voice:channel-left', {
          serverId,
          channelId,
          userId,
        });
      }

      const memberCount = await this.presence.count(channelId);
      const mode = this.resolveMode(memberCount);
      await this.maybeAnnounceModeSwitch(channelId, mode);
    }
  }

  private async maybeAnnounceModeSwitch(
    channelId: string,
    mode: VoiceMode,
  ): Promise<void> {
    if (!this.sfu.isEnabled()) return;
    this.server.to(`voice:${channelId}`).emit('voice:mode', {
      channelId,
      mode,
      threshold: this.sfu.threshold,
      sfuEnabled: this.sfu.isEnabled(),
    });
  }

  /** Forwards a signaling event to all sockets of the target user. */
  private relay(
    client: Socket,
    toUserId: string,
    event: string,
    payload: Record<string, any>,
  ) {
    const user = this.userOf(client);
    if (!toUserId) throw new WsException('toUserId is required');
    this.server.to(`voice-user:${toUserId}`).emit(event, {
      fromUserId: user.id,
      ...payload,
    });
  }

  private async authenticate(client: Socket): Promise<AuthUser | null> {
    return WsJwtGuard.authenticate(client, this.auth);
  }

  private userOf(client: Socket): AuthUser {
    const user = client.data?.user as AuthUser | undefined;
    if (!user) throw new WsException('Unauthorized');
    return user;
  }
}

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
interface StatePayload {
  muted?: boolean;
  deafened?: boolean;
  speaking?: boolean;
}
interface StreamPayload {
  channelId?: string;
  source?: 'screen' | 'camera';
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
  streaming: boolean;
}

/**
 * Voice + streaming gateway. ALL media (audio + screen/camera) flows through
 * LiveKit (SFU); there is no mesh P2P. This gateway is the control plane:
 * it authorizes joins, mints LiveKit tokens, tracks presence in Redis and
 * broadcasts membership / mic / streaming state to the app.
 */
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
    this.realtime.setVoiceServer(server);
    this.logger.log('Voice gateway initialized on /ws-voice (LiveKit SFU)');
  }

  async handleConnection(client: Socket) {
    const user = await WsJwtGuard.authenticate(client, this.auth);
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Invalid token' });
      client.disconnect(true);
      return;
    }
    const cards = await this.users.getCards([user.id]);
    const card = cards.get(user.id);
    if (card) {
      user.displayName = card.displayName;
      user.avatarUrl = card.avatarUrl;
    }
    client.data.user = user;
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

  /**
   * Join a voice channel. Returns the LiveKit credentials the client uses
   * to connect to the SFU room, plus the current member list.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('voice:join')
  async onJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: JoinPayload,
  ) {
    const user = this.userOf(client);
    const channelId = body?.channelId;
    if (!channelId) throw new WsException('channelId is required');

    if (!this.sfu.isEnabled()) {
      throw new WsException('Voice service (LiveKit) is not configured');
    }

    const channel = await this.channels.assertAccess(channelId, user.id);
    if (channel.type !== ChannelType.VOICE) {
      throw new WsException('Channel is not a voice channel');
    }

    // Leave any previous channel cleanly.
    const previous = await this.presence.getChannelOfUser(user.id);
    if (previous && previous !== channelId) {
      await this.handleSocketLeave(previous, user.id, client.id);
      client.leave(`voice:${previous}`);
    }

    const limit = channel.userLimit ?? 0;
    const { full, isNewMember } = await this.presence.join(
      channelId,
      user.id,
      client.id,
      limit,
    );
    if (full) throw new WsException('Voice channel is full');

    client.join(`voice:${channelId}`);

    // Mint the LiveKit token (audio + video capable).
    const creds = await this.sfu.createToken(
      channelId,
      user.id,
      user.username,
    );
    if (!creds) throw new WsException('Failed to create voice token');

    // Current members (DB-backed cards + state).
    const members = await this.buildMembers(channelId);
    const meCard =
      members.find((m) => m.userId === user.id)?.user ??
      this.cardFromUser(user);

    if (isNewMember) {
      const member: VoiceMember = {
        userId: user.id,
        user: meCard,
        muted: false,
        deafened: false,
        speaking: false,
        streaming: false,
      };
      client
        .to(`voice:${channelId}`)
        .emit('voice:user-joined', { channelId, user: member });
      this.realtime.emitToServer(
        channel.serverId.toString(),
        'voice:channel-joined',
        { serverId: channel.serverId.toString(), channelId, member },
      );
    }

    // peers = everyone except me (frontend still gets the full roster).
    const peers = members.filter((m) => m.userId !== user.id);
    client.emit('voice:peers', { channelId, peers });

    return {
      channelId,
      livekit: creds, // { url, token, room, identity }
      peers,
    };
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

  /** Re-fetch a LiveKit token (e.g. after expiry). */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('voice:token')
  async onToken(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: JoinPayload,
  ) {
    const user = this.userOf(client);
    const channelId = await this.presence.getChannelOfUser(user.id);
    if (!channelId || channelId !== body.channelId) {
      throw new WsException('Not in this voice channel');
    }
    const creds = await this.sfu.createToken(channelId, user.id, user.username);
    if (!creds) throw new WsException('Voice service not available');
    return creds;
  }

  // ── Mic / deafen / speaking state ─────────────────────────────
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
      streaming: prev.streaming,
    };
    await this.presence.setState(channelId, user.id, state);

    this.server
      .to(`voice:${channelId}`)
      .emit('voice:state-changed', { userId: user.id, ...state });

    const serverId = await this.channels.getServerIdOfChannel(channelId);
    if (serverId) {
      this.realtime.emitToServer(serverId, 'voice:channel-state', {
        serverId,
        channelId,
        userId: user.id,
        muted: state.muted,
        deafened: state.deafened,
        streaming: state.streaming,
      });
    }
    return { ok: true };
  }

  // ── Streaming (screen share / camera) ─────────────────────────

  /**
   * Marks the user as streaming in their current voice channel. The actual
   * video track is published directly to LiveKit by the client; this only
   * updates presence + notifies the app so others can show a "Live" badge
   * and offer to watch.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('stream:start')
  async onStreamStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: StreamPayload,
  ) {
    const user = this.userOf(client);
    const channelId = await this.presence.getChannelOfUser(user.id);
    if (!channelId) throw new WsException('Join a voice channel first');

    const state = await this.presence.getState(channelId, user.id);
    state.streaming = true;
    await this.presence.setState(channelId, user.id, state);

    const source = body?.source === 'camera' ? 'camera' : 'screen';
    const payload = {
      channelId,
      userId: user.id,
      user: this.cardFromUser(user),
      source,
    };
    // Notify people in the room + the whole server (for the Live badge).
    this.server.to(`voice:${channelId}`).emit('stream:started', payload);
    const serverId = await this.channels.getServerIdOfChannel(channelId);
    if (serverId) {
      this.realtime.emitToServer(serverId, 'stream:started', {
        serverId,
        ...payload,
      });
    }
    return { ok: true, channelId, source };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('stream:stop')
  async onStreamStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() _body: StreamPayload,
  ) {
    const user = this.userOf(client);
    const channelId = await this.presence.getChannelOfUser(user.id);
    if (!channelId) return { ok: false };
    await this.stopStreaming(channelId, user.id);
    return { ok: true };
  }

  // ── Helpers ───────────────────────────────────────────────────

  private async stopStreaming(channelId: string, userId: string) {
    const state = await this.presence.getState(channelId, userId);
    if (!state.streaming) return;
    state.streaming = false;
    await this.presence.setState(channelId, userId, state);
    const payload = { channelId, userId };
    this.server.to(`voice:${channelId}`).emit('stream:stopped', payload);
    const serverId = await this.channels.getServerIdOfChannel(channelId);
    if (serverId) {
      this.realtime.emitToServer(serverId, 'stream:stopped', {
        serverId,
        ...payload,
      });
    }
  }

  private async buildMembers(channelId: string): Promise<VoiceMember[]> {
    const withState = await this.presence.getMembersWithState(channelId);
    const cards = await this.users.getCards(withState.map((m) => m.userId));
    return withState.map((m) => ({
      userId: m.userId,
      user: cards.get(m.userId) ?? { id: m.userId, username: 'unknown' },
      muted: m.state.muted,
      deafened: m.state.deafened,
      speaking: m.state.speaking,
      streaming: m.state.streaming,
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

  /**
   * Removes one socket. Broadcasts `voice:user-left` only when the user's
   * last socket leaves the channel (multi-tab / multi-device safe). Also
   * stops any active stream for that user.
   */
  private async handleSocketLeave(
    channelId: string,
    userId: string,
    socketId: string,
  ): Promise<void> {
    // Stop streaming first (so the Live badge clears) before presence drops.
    await this.stopStreaming(channelId, userId).catch(() => undefined);

    const { removedMember } = await this.presence.removeSocket(
      channelId,
      userId,
      socketId,
    );
    if (removedMember) {
      this.server
        .to(`voice:${channelId}`)
        .emit('voice:user-left', { channelId, userId });
      const serverId = await this.channels.getServerIdOfChannel(channelId);
      if (serverId) {
        this.realtime.emitToServer(serverId, 'voice:channel-left', {
          serverId,
          channelId,
          userId,
        });
      }
    }
  }

  private userOf(client: Socket): AuthUser {
    const user = client.data?.user as AuthUser | undefined;
    if (!user) throw new WsException('Unauthorized');
    return user;
  }
}

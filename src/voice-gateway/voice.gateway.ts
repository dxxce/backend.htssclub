import { Logger, UseGuards } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
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
import { SfuService } from './sfu.service';
import { VoicePresenceService } from './voice-presence.service';

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

type VoiceMode = 'mesh' | 'sfu';

@WebSocketGateway({ namespace: '/ws-voice', cors: true })
export class VoiceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(VoiceGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly channels: ChannelsService,
    private readonly presence: VoicePresenceService,
    private readonly sfu: SfuService,
  ) {}

  async handleConnection(client: Socket) {
    const user = await WsJwtGuard.authenticate(client, this.auth);
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Invalid token' });
      client.disconnect(true);
      return;
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
    const channel = await this.channels.assertAccess(body.channelId, user.id);
    if (channel.type !== ChannelType.VOICE) {
      throw new WsException('Channel is not a voice channel');
    }

    // If the socket was in another channel, leave it cleanly first.
    const previous = await this.presence.getChannelOfUser(user.id);
    if (previous && previous !== body.channelId) {
      await this.handleSocketLeave(previous, user.id, client.id);
      client.leave(`voice:${previous}`);
    }

    // Atomic join + userLimit enforcement (prevents races).
    const limit = channel.userLimit ?? 0;
    const { full, isNewMember, memberCount } = await this.presence.join(
      body.channelId,
      user.id,
      client.id,
      limit,
    );
    if (full) {
      throw new WsException('Voice channel is full');
    }

    client.join(`voice:${body.channelId}`);

    const mode = this.resolveMode(memberCount);

    // Notify existing peers only when a brand-new member joins.
    if (isNewMember) {
      client.to(`voice:${body.channelId}`).emit('voice:user-joined', {
        channelId: body.channelId,
        user: { id: user.id, username: user.username },
        mode,
      });
    }

    // If the channel just crossed the SFU threshold, tell everyone to
    // migrate from mesh to SFU.
    await this.maybeAnnounceModeSwitch(body.channelId, mode);

    const peers = await this.presence.getMembersWithState(body.channelId);
    const response: Record<string, any> = {
      channelId: body.channelId,
      mode,
      peers: peers.filter((p) => p.userId !== user.id),
    };

    // In SFU mode hand back a LiveKit token so the client connects to the SFU.
    if (mode === 'sfu') {
      const creds = await this.sfu.createToken(
        body.channelId,
        user.id,
        user.username,
      );
      if (creds) response.sfu = creds;
    }
    return response;
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('voice:leave')
  async onLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: JoinPayload,
  ) {
    const user = this.userOf(client);
    client.leave(`voice:${body.channelId}`);
    await this.handleSocketLeave(body.channelId, user.id, client.id);
    return { left: body.channelId };
  }

  /**
   * Allows a client already in SFU mode to (re)fetch its LiveKit token,
   * e.g. after a mode-switch announcement or token expiry.
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

  // ── Mesh signaling (used when mode === 'mesh') ────────────────
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
    const state = {
      muted: !!body.muted,
      deafened: !!body.deafened,
      speaking: !!body.speaking,
    };
    await this.presence.setState(channelId, user.id, state);
    this.server.to(`voice:${channelId}`).emit('voice:state-changed', {
      userId: user.id,
      ...state,
    });
    return { ok: true };
  }

  // ── Helpers ───────────────────────────────────────────────────
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
      this.server.to(`voice:${channelId}`).emit('voice:user-left', {
        channelId,
        userId,
      });
      // If the channel dropped back below the threshold, tell remaining
      // peers they can fall back to mesh.
      const memberCount = await this.presence.count(channelId);
      const mode = this.resolveMode(memberCount);
      await this.maybeAnnounceModeSwitch(channelId, mode);
    }
  }

  /**
   * Announces the current voice transport mode for a channel. Clients
   * listen for `voice:mode` to switch between mesh P2P and SFU.
   */
  private async maybeAnnounceModeSwitch(
    channelId: string,
    mode: VoiceMode,
  ): Promise<void> {
    this.server.to(`voice:${channelId}`).emit('voice:mode', {
      channelId,
      mode,
      threshold: this.sfu.threshold,
      sfuEnabled: this.sfu.isEnabled(),
    });
  }

  private relay(
    client: Socket,
    toUserId: string,
    event: string,
    payload: Record<string, any>,
  ) {
    const user = this.userOf(client);
    this.server.to(`voice-user:${toUserId}`).emit(event, {
      fromUserId: user.id,
      ...payload,
    });
  }

  private userOf(client: Socket): AuthUser {
    const user = client.data?.user as AuthUser | undefined;
    if (!user) throw new WsException('Unauthorized');
    return user;
  }
}

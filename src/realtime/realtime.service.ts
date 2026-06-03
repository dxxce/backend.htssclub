import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';

/**
 * Holds a reference to the chat Socket.IO server and provides helpers
 * for other modules (notifications, friends, admin) to emit events to
 * rooms without depending on the gateway directly.
 *
 * Rooms convention:
 *  - user:{userId}        private events
 *  - server:{serverId}    server-wide events
 *  - channel:{channelId}  channel chat events
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private server?: Server;
  private voiceServer?: Server;

  setServer(server: Server): void {
    this.server = server;
  }

  /** Registered by the VoiceGateway so we can target the /ws-voice namespace. */
  setVoiceServer(server: Server): void {
    this.voiceServer = server;
  }

  emitToUser(userId: string, event: string, payload: unknown): void {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  emitToServer(serverId: string, event: string, payload: unknown): void {
    this.server?.to(`server:${serverId}`).emit(event, payload);
  }

  emitToChannel(channelId: string, event: string, payload: unknown): void {
    this.server?.to(`channel:${channelId}`).emit(event, payload);
  }

  emitToUsers(userIds: string[], event: string, payload: unknown): void {
    if (!this.server) return;
    const rooms = userIds.map((id) => `user:${id}`);
    if (rooms.length) this.server.to(rooms).emit(event, payload);
  }

  /** Emit to everyone in a voice channel room on the /ws-voice namespace. */
  emitToVoiceChannel(channelId: string, event: string, payload: unknown): void {
    this.voiceServer?.to(`voice:${channelId}`).emit(event, payload);
  }

  /** Disconnect all voice sockets currently in a voice channel room. */
  closeVoiceChannel(channelId: string, event: string, payload: unknown): void {
    if (!this.voiceServer) return;
    const room = this.voiceServer.to(`voice:${channelId}`);
    room.emit(event, payload);
    room.disconnectSockets(true);
  }

  /** Force-disconnect all sockets belonging to a user (e.g. on ban). */
  disconnectUser(userId: string): void {
    if (!this.server) return;
    this.server
      .in(`user:${userId}`)
      .disconnectSockets(true);
  }
}

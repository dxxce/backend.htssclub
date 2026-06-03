import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken } from 'livekit-server-sdk';

export interface SfuCredentials {
  url: string;
  token: string;
  room: string;
}

/**
 * Mints LiveKit access tokens so clients can connect directly to the SFU
 * for large voice rooms. Each voice channel maps to one LiveKit room.
 */
@Injectable()
export class SfuService {
  private readonly logger = new Logger(SfuService.name);

  constructor(private readonly config: ConfigService) {}

  /** Whether SFU is configured and usable. */
  isEnabled(): boolean {
    return Boolean(
      this.config.get<string>('voice.livekit.url') &&
        this.config.get<string>('voice.livekit.apiKey') &&
        this.config.get<string>('voice.livekit.apiSecret'),
    );
  }

  /** Participant count at which a channel switches to SFU mode. */
  get threshold(): number {
    return this.config.get<number>('voice.sfuThreshold') ?? 8;
  }

  roomName(channelId: string): string {
    return `voice_${channelId}`;
  }

  /**
   * Issues a join token for a user to connect to the SFU room of a channel.
   * Returns null if SFU is not configured.
   */
  async createToken(
    channelId: string,
    userId: string,
    displayName?: string,
  ): Promise<SfuCredentials | null> {
    if (!this.isEnabled()) return null;
    const apiKey = this.config.get<string>('voice.livekit.apiKey')!;
    const apiSecret = this.config.get<string>('voice.livekit.apiSecret')!;
    const url = this.config.get<string>('voice.livekit.url')!;
    const room = this.roomName(channelId);

    const at = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      name: displayName || userId,
      ttl: '1h',
    });
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();
    return { url, token, room };
  }
}

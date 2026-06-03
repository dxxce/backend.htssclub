import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken } from 'livekit-server-sdk';

export interface SfuCredentials {
  url: string;
  token: string;
  room: string;
  identity: string;
}

/**
 * Mints LiveKit access tokens. ALL voice + streaming runs through the SFU
 * (no mesh P2P). Each voice channel maps to one LiveKit room. The granted
 * token allows publishing audio AND video tracks (screen share / camera),
 * so the same token powers both talking and streaming.
 */
@Injectable()
export class SfuService {
  private readonly logger = new Logger(SfuService.name);

  constructor(private readonly config: ConfigService) {}

  /** Whether LiveKit is configured and usable. */
  isEnabled(): boolean {
    return Boolean(
      this.config.get<string>('voice.livekit.url') &&
        this.config.get<string>('voice.livekit.apiKey') &&
        this.config.get<string>('voice.livekit.apiSecret'),
    );
  }

  roomName(channelId: string): string {
    return `voice_${channelId}`;
  }

  /**
   * Issues a join token for a user to connect to the LiveKit room of a
   * channel. The identity is the userId so the backend can correlate
   * LiveKit participants with app users. Returns null if not configured.
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
      canPublish: true, // audio + video (screen share / camera)
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();
    return { url, token, room, identity: userId };
  }
}

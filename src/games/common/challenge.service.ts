import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { GameMode, GameType } from '../../common/enums';

export interface PendingChallenge {
  id: string;
  game: GameType;
  fromUserId: string;
  toUserId: string;
  mode: GameMode;
  betAmount: number;
  createdAt: number;
}

const KEY = (id: string) => `challenge:${id}`;
export const CHALLENGE_TTL_MS = 45_000;

/**
 * Stores short-lived 1v1 challenge invitations in Redis (TTL). A challenge is
 * created when a player invites another; the game is only created once the
 * invitee accepts. Works across instances (Redis + Socket.IO adapter).
 */
@Injectable()
export class ChallengeService {
  private readonly logger = new Logger(ChallengeService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async create(
    game: GameType,
    fromUserId: string,
    toUserId: string,
    mode: GameMode,
    betAmount: number,
  ): Promise<PendingChallenge> {
    const challenge: PendingChallenge = {
      id: randomUUID(),
      game,
      fromUserId,
      toUserId,
      mode,
      betAmount,
      createdAt: Date.now(),
    };
    await this.redis.set(
      KEY(challenge.id),
      JSON.stringify(challenge),
      'PX',
      CHALLENGE_TTL_MS,
    );
    return challenge;
  }

  async get(id: string): Promise<PendingChallenge | null> {
    const raw = await this.redis.get(KEY(id));
    return raw ? (JSON.parse(raw) as PendingChallenge) : null;
  }

  /** Atomically fetch-and-remove a challenge so it can be accepted only once. */
  async claim(id: string): Promise<PendingChallenge | null> {
    const raw = (await this.redis.call('GETDEL', KEY(id))) as string | null;
    return raw ? (JSON.parse(raw) as PendingChallenge) : null;
  }

  async remove(id: string): Promise<void> {
    await this.redis.del(KEY(id));
  }
}

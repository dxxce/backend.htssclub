import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

const QUEUE_KEY = 'caro:queue'; // sorted set: member=userId, score=rp
const QUEUE_META = 'caro:queue:meta'; // hash: userId -> JSON { socketId, joinedAt }

export interface QueuedPlayer {
  userId: string;
  rp: number;
  socketId: string;
}

/**
 * Simple Redis-backed matchmaking for ranked Caro. Players are placed in a
 * sorted set keyed by RP; matching pairs the closest-RP opponents. Works
 * across multiple backend instances because state lives in Redis.
 */
@Injectable()
export class CaroMatchmakingService {
  private readonly logger = new Logger(CaroMatchmakingService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async enqueue(userId: string, rp: number, socketId: string): Promise<void> {
    await this.redis
      .multi()
      .zadd(QUEUE_KEY, rp, userId)
      .hset(
        QUEUE_META,
        userId,
        JSON.stringify({ socketId, joinedAt: Date.now() }),
      )
      .exec();
  }

  async dequeue(userId: string): Promise<void> {
    await this.redis.multi().zrem(QUEUE_KEY, userId).hdel(QUEUE_META, userId).exec();
  }

  async isQueued(userId: string): Promise<boolean> {
    const score = await this.redis.zscore(QUEUE_KEY, userId);
    return score !== null;
  }

  async size(): Promise<number> {
    return this.redis.zcard(QUEUE_KEY);
  }

  /**
   * Tries to find an opponent for `userId` (already enqueued). Atomically
   * removes BOTH players from the queue if a match is found. Returns the
   * opponent or null. Picks the nearest RP neighbour.
   */
  async tryMatch(userId: string): Promise<QueuedPlayer | null> {
    const myScore = await this.redis.zscore(QUEUE_KEY, userId);
    if (myScore === null) return null;
    const myRp = Number(myScore);

    // Candidates: everyone in the queue with rank, ordered by RP.
    const all = await this.redis.zrange(QUEUE_KEY, 0, -1, 'WITHSCORES');
    let best: { userId: string; rp: number } | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < all.length; i += 2) {
      const candId = all[i];
      const candRp = Number(all[i + 1]);
      if (candId === userId) continue;
      const dist = Math.abs(candRp - myRp);
      if (dist < bestDist) {
        bestDist = dist;
        best = { userId: candId, rp: candRp };
      }
    }
    if (!best) return null;

    // Atomically claim both players (Lua) so two instances can't double-match.
    const script = `
      local a = redis.call('ZSCORE', KEYS[1], ARGV[1])
      local b = redis.call('ZSCORE', KEYS[1], ARGV[2])
      if a == false or b == false then return 0 end
      redis.call('ZREM', KEYS[1], ARGV[1], ARGV[2])
      return 1
    `;
    const claimed = (await this.redis.eval(
      script,
      1,
      QUEUE_KEY,
      userId,
      best.userId,
    )) as number;
    if (claimed !== 1) return null;

    const meta = await this.redis.hget(QUEUE_META, best.userId);
    await this.redis.hdel(QUEUE_META, userId, best.userId);
    const socketId = meta ? (JSON.parse(meta).socketId as string) : '';
    return { userId: best.userId, rp: best.rp, socketId };
  }
}

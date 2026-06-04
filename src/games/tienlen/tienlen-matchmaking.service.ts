import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

// One queue per target table size (2,3,4). Members = userId, score = joinedAt.
const queueKey = (size: number) => `tienlen:queue:${size}`;
const metaKey = (size: number) => `tienlen:queue:${size}:meta`;

export interface TlQueued {
  userId: string;
  socketId: string;
}

/**
 * Redis-backed matchmaking for ranked Tiến Lên. Players pick a table size
 * (2..4); when enough players are waiting for that size, the oldest N are
 * atomically claimed and a game is created. Works across instances.
 */
@Injectable()
export class TienLenMatchmakingService {
  private readonly logger = new Logger(TienLenMatchmakingService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async enqueue(size: number, userId: string, socketId: string): Promise<void> {
    await this.redis
      .multi()
      .zadd(queueKey(size), Date.now(), userId)
      .hset(metaKey(size), userId, JSON.stringify({ socketId }))
      .exec();
  }

  async dequeue(userId: string): Promise<void> {
    const multi = this.redis.multi();
    for (const size of [2, 3, 4]) {
      multi.zrem(queueKey(size), userId);
      multi.hdel(metaKey(size), userId);
    }
    await multi.exec();
  }

  async isQueued(userId: string): Promise<boolean> {
    for (const size of [2, 3, 4]) {
      const s = await this.redis.zscore(queueKey(size), userId);
      if (s !== null) return true;
    }
    return false;
  }

  /** Number of players waiting for a given table size. */
  async size(tableSize: number): Promise<number> {
    return this.redis.zcard(queueKey(tableSize));
  }

  /** Counts for all table sizes (for the lobby live display). */
  async counts(): Promise<Record<number, number>> {
    const [c2, c3, c4] = await Promise.all([
      this.redis.zcard(queueKey(2)),
      this.redis.zcard(queueKey(3)),
      this.redis.zcard(queueKey(4)),
    ]);
    return { 2: c2, 3: c3, 4: c4 };
  }

  /** Queued userIds for each table size (for showing who's waiting). */
  async listQueued(): Promise<Record<number, string[]>> {
    const [q2, q3, q4] = await Promise.all([
      this.redis.zrange(queueKey(2), 0, -1),
      this.redis.zrange(queueKey(3), 0, -1),
      this.redis.zrange(queueKey(4), 0, -1),
    ]);
    return { 2: q2, 3: q3, 4: q4 };
  }

  /**
   * If at least `size` players wait for `size`, atomically claims the oldest
   * `size` of them (Lua) and returns their ids. Otherwise null. The caller
   * (must include the just-enqueued user) creates the game.
   */
  async tryMatch(size: number): Promise<string[] | null> {
    const script = `
      local n = tonumber(ARGV[1])
      local count = redis.call('ZCARD', KEYS[1])
      if count < n then return {} end
      local members = redis.call('ZRANGE', KEYS[1], 0, n - 1)
      if #members < n then return {} end
      for i = 1, #members do
        redis.call('ZREM', KEYS[1], members[i])
      end
      return members
    `;
    const claimed = (await this.redis.eval(
      script,
      1,
      queueKey(size),
      String(size),
    )) as string[];
    if (!claimed || claimed.length < size) return null;
    // Clean up meta for the claimed players.
    await this.redis.hdel(metaKey(size), ...claimed);
    return claimed;
  }
}

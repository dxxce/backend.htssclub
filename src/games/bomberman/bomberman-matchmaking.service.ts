import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

// One queue per table size (2,3,4). member=userId, score=rp.
const QUEUE_KEY = (size: number) => `bomberman:queue:${size}`;
const META_KEY = 'bomberman:queue:meta'; // hash userId -> JSON { size, socketId }

export interface BmQueued {
  userId: string;
  rp: number;
}

/**
 * Redis-backed matchmaking for ranked Bomberman. A separate sorted set per
 * table size (2/3/4). When a size's queue reaches `size` players they are
 * atomically claimed and a match is formed. Multi-instance safe.
 */
@Injectable()
export class BombermanMatchmakingService {
  private readonly logger = new Logger(BombermanMatchmakingService.name);
  static readonly SIZES = [2, 3, 4];

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async enqueue(userId: string, size: number, rp: number, socketId: string): Promise<void> {
    await this.dequeue(userId); // ensure only one queue at a time
    await this.redis
      .multi()
      .zadd(QUEUE_KEY(size), rp, userId)
      .hset(META_KEY, userId, JSON.stringify({ size, socketId, joinedAt: Date.now() }))
      .exec();
  }

  async dequeue(userId: string): Promise<void> {
    const meta = await this.redis.hget(META_KEY, userId);
    if (meta) {
      const { size } = JSON.parse(meta);
      await this.redis.zrem(QUEUE_KEY(size), userId);
    } else {
      // fallback: remove from every size
      await Promise.all(BombermanMatchmakingService.SIZES.map((s) => this.redis.zrem(QUEUE_KEY(s), userId)));
    }
    await this.redis.hdel(META_KEY, userId);
  }

  async isQueued(userId: string): Promise<boolean> {
    return (await this.redis.hexists(META_KEY, userId)) === 1;
  }

  /** Counts per size: { "2": n, "3": n, "4": n }. */
  async counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    await Promise.all(
      BombermanMatchmakingService.SIZES.map(async (s) => {
        out[String(s)] = await this.redis.zcard(QUEUE_KEY(s));
      }),
    );
    return out;
  }

  /** Queued players grouped by size (userId + rp), for lobby display. */
  async listBySize(): Promise<Record<string, BmQueued[]>> {
    const out: Record<string, BmQueued[]> = {};
    await Promise.all(
      BombermanMatchmakingService.SIZES.map(async (s) => {
        const all = await this.redis.zrange(QUEUE_KEY(s), 0, -1, 'WITHSCORES');
        const list: BmQueued[] = [];
        for (let i = 0; i < all.length; i += 2) list.push({ userId: all[i], rp: Number(all[i + 1]) });
        out[String(s)] = list;
      }),
    );
    return out;
  }

  /**
   * If the queue for `size` has at least `size` players, atomically claim the
   * `size` closest-RP players (anchored on `userId`) and return their ids.
   * Returns null if not enough players yet.
   */
  async tryMatch(userId: string, size: number): Promise<string[] | null> {
    const all = await this.redis.zrange(QUEUE_KEY(size), 0, -1, 'WITHSCORES');
    const pool: { userId: string; rp: number }[] = [];
    for (let i = 0; i < all.length; i += 2) pool.push({ userId: all[i], rp: Number(all[i + 1]) });
    if (pool.length < size) return null;

    const me = pool.find((p) => p.userId === userId);
    if (!me) return null;
    // pick the `size` players whose RP is closest to me (including me).
    pool.sort((a, b) => Math.abs(a.rp - me.rp) - Math.abs(b.rp - me.rp));
    const chosen = pool.slice(0, size).map((p) => p.userId);

    // Atomically claim all chosen (Lua): only succeed if all still queued.
    const script = `
      for i=1,#ARGV do
        if redis.call('ZSCORE', KEYS[1], ARGV[i]) == false then return 0 end
      end
      for i=1,#ARGV do redis.call('ZREM', KEYS[1], ARGV[i]) end
      return 1
    `;
    const claimed = (await this.redis.eval(script, 1, QUEUE_KEY(size), ...chosen)) as number;
    if (claimed !== 1) return null;
    await this.redis.hdel(META_KEY, ...chosen);
    return chosen;
  }
}

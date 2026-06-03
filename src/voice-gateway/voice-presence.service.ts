import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

export interface VoiceMemberState {
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  streaming: boolean;
}

const DEFAULT_STATE: VoiceMemberState = {
  muted: false,
  deafened: false,
  speaking: false,
  streaming: false,
};

/**
 * Tracks voice channel membership in Redis with multi-socket awareness.
 *
 * Keys:
 *  - voice:channel:{channelId}            Set<userId>      members in a channel
 *  - voice:user:{userId}                  channelId        which channel a user is in
 *  - voice:sockets:{channelId}:{userId}   Set<socketId>    a user's live sockets in that channel
 *  - voice:state:{channelId}:{userId}     JSON             mic/speaker state
 */
@Injectable()
export class VoicePresenceService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private channelKey(channelId: string): string {
    return `voice:channel:${channelId}`;
  }
  private userKey(userId: string): string {
    return `voice:user:${userId}`;
  }
  private socketsKey(channelId: string, userId: string): string {
    return `voice:sockets:${channelId}:${userId}`;
  }
  private stateKey(channelId: string, userId: string): string {
    return `voice:state:${channelId}:${userId}`;
  }

  /**
   * Atomically registers a socket for a user joining a channel, enforcing
   * `userLimit` in the same operation to avoid races. Returns:
   *  - isNewMember: true if this is the user's first socket in the channel
   *  - full: true if the join was rejected because the channel is full
   *  - memberCount: member count after the operation
   *
   * A `userLimit <= 0` means unlimited.
   */
  async join(
    channelId: string,
    userId: string,
    socketId: string,
    userLimit: number,
  ): Promise<{ isNewMember: boolean; full: boolean; memberCount: number }> {
    // KEYS[1] = channel set, KEYS[2] = user->channel, KEYS[3] = sockets set
    // ARGV[1] = userId, ARGV[2] = socketId, ARGV[3] = channelId, ARGV[4] = limit
    const script = `
      local isMember = redis.call('SISMEMBER', KEYS[1], ARGV[1])
      if isMember == 0 then
        local limit = tonumber(ARGV[4])
        if limit > 0 then
          local count = redis.call('SCARD', KEYS[1])
          if count >= limit then
            return {0, 1, count}
          end
        end
        redis.call('SADD', KEYS[1], ARGV[1])
      end
      redis.call('SET', KEYS[2], ARGV[3])
      redis.call('SADD', KEYS[3], ARGV[2])
      local newCount = redis.call('SCARD', KEYS[1])
      if isMember == 0 then
        return {1, 0, newCount}
      else
        return {0, 0, newCount}
      end
    `;
    const result = (await this.redis.eval(
      script,
      3,
      this.channelKey(channelId),
      this.userKey(userId),
      this.socketsKey(channelId, userId),
      userId,
      socketId,
      channelId,
      String(userLimit ?? 0),
    )) as [number, number, number];

    return {
      isNewMember: result[0] === 1,
      full: result[1] === 1,
      memberCount: result[2],
    };
  }

  /**
   * Removes a single socket. The user only truly leaves the channel (and
   * `voice:user-left` should be broadcast) when their last socket is gone.
   * Returns `removedMember: true` only on that final removal.
   */
  async removeSocket(
    channelId: string,
    userId: string,
    socketId: string,
  ): Promise<{ removedMember: boolean; remainingSockets: number }> {
    const script = `
      redis.call('SREM', KEYS[3], ARGV[2])
      local remaining = redis.call('SCARD', KEYS[3])
      if remaining == 0 then
        redis.call('SREM', KEYS[1], ARGV[1])
        redis.call('DEL', KEYS[4])
        local cur = redis.call('GET', KEYS[2])
        if cur == ARGV[3] then
          redis.call('DEL', KEYS[2])
        end
        return {1, 0}
      end
      return {0, remaining}
    `;
    const result = (await this.redis.eval(
      script,
      4,
      this.channelKey(channelId),
      this.userKey(userId),
      this.socketsKey(channelId, userId),
      this.stateKey(channelId, userId),
      userId,
      socketId,
      channelId,
    )) as [number, number];

    return {
      removedMember: result[0] === 1,
      remainingSockets: result[1],
    };
  }

  /** Force-remove a user entirely from a channel (all sockets). */
  async removeUser(channelId: string, userId: string): Promise<void> {
    await this.redis
      .multi()
      .srem(this.channelKey(channelId), userId)
      .del(this.socketsKey(channelId, userId))
      .del(this.stateKey(channelId, userId))
      .del(this.userKey(userId))
      .exec();
  }

  async getChannelOfUser(userId: string): Promise<string | null> {
    return this.redis.get(this.userKey(userId));
  }

  async listMembers(channelId: string): Promise<string[]> {
    return this.redis.smembers(this.channelKey(channelId));
  }

  async count(channelId: string): Promise<number> {
    return this.redis.scard(this.channelKey(channelId));
  }

  async setState(
    channelId: string,
    userId: string,
    state: VoiceMemberState,
  ): Promise<void> {
    await this.redis.set(
      this.stateKey(channelId, userId),
      JSON.stringify(state),
    );
  }

  async getState(
    channelId: string,
    userId: string,
  ): Promise<VoiceMemberState> {
    const raw = await this.redis.get(this.stateKey(channelId, userId));
    return raw ? { ...DEFAULT_STATE, ...JSON.parse(raw) } : { ...DEFAULT_STATE };
  }

  async getMembersWithState(
    channelId: string,
  ): Promise<{ userId: string; state: VoiceMemberState }[]> {
    const ids = await this.listMembers(channelId);
    const states = await Promise.all(
      ids.map((id) => this.getState(channelId, id)),
    );
    return ids.map((userId, i) => ({ userId, state: states[i] }));
  }
}

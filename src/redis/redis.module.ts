import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import Redis, { RedisOptions } from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';
export const REDIS_SUBSCRIBER = 'REDIS_SUBSCRIBER';

const logger = new Logger('Redis');

/**
 * Builds an ioredis client with a backoff retry strategy and an attached
 * `error` listener. Without an `error` listener ioredis logs noisy
 * "Unhandled error event" warnings (e.g. on ECONNRESET / ECONNREFUSED).
 */
function createRedisClient(url: string, label: string): Redis {
  const options: RedisOptions = {
    lazyConnect: false,
    // Allow commands to fail fast instead of queueing forever when down.
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    retryStrategy: (times) => {
      // Exponential backoff capped at 5s; keeps trying to reconnect.
      const delay = Math.min(times * 200, 5000);
      return delay;
    },
    reconnectOnError: (err) => {
      // Reconnect on transient connection-reset style errors.
      const target = ['READONLY', 'ECONNRESET', 'EPIPE'];
      return target.some((t) => err.message.includes(t));
    },
  };

  const client = new Redis(url, options);

  // Swallow + log error events so they don't crash the process or spam
  // the default "Unhandled error event" message.
  let warnedDown = false;
  client.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET') {
      if (!warnedDown) {
        logger.warn(
          `[${label}] Redis connection issue (${err.code}); retrying in background...`,
        );
        warnedDown = true;
      }
      return;
    }
    logger.error(`[${label}] Redis error: ${err.message}`);
  });

  client.on('ready', () => {
    if (warnedDown) {
      logger.log(`[${label}] Redis connection restored`);
      warnedDown = false;
    }
  });

  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createRedisClient(config.get<string>('redisUrl')!, 'client'),
    },
    {
      provide: REDIS_SUBSCRIBER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createRedisClient(config.get<string>('redisUrl')!, 'subscriber'),
    },
  ],
  exports: [REDIS_CLIENT, REDIS_SUBSCRIBER],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown(): Promise<void> {
    // Gracefully close connections so the process can exit cleanly.
    for (const token of [REDIS_CLIENT, REDIS_SUBSCRIBER]) {
      try {
        const client = this.moduleRef.get<Redis>(token, { strict: false });
        await client?.quit();
      } catch {
        // ignore
      }
    }
  }
}

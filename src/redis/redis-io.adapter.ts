import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ServerOptions } from 'socket.io';
import { REDIS_CLIENT, REDIS_SUBSCRIBER } from './redis.module';

/**
 * Socket.IO adapter that uses the Redis pub/sub adapter so events
 * broadcast across multiple backend instances.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(
    app: INestApplicationContext,
    private readonly corsOrigins: string[],
  ) {
    super(app);
    try {
      const pubClient = app.get<Redis>(REDIS_CLIENT);
      const subClient = app.get<Redis>(REDIS_SUBSCRIBER);
      const pub = pubClient.duplicate();
      const sub = subClient.duplicate();
      // Duplicated clients need their own error listeners, otherwise
      // ioredis emits "Unhandled error event" on connection drops.
      pub.on('error', (err) =>
        this.logger.warn(`Socket.IO pub client: ${err.message}`),
      );
      sub.on('error', (err) =>
        this.logger.warn(`Socket.IO sub client: ${err.message}`),
      );
      this.adapterConstructor = createAdapter(pub, sub);
    } catch (err) {
      this.logger.warn(
        'Redis adapter unavailable; running Socket.IO in single-instance mode',
      );
    }
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: this.corsOrigins.length ? this.corsOrigins : true,
        credentials: true,
      },
    });
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}

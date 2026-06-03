import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser = require('cookie-parser');
import { join } from 'path';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './redis/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
  });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const apiPrefix = config.get<string>('apiPrefix') || 'api';
  app.setGlobalPrefix(apiPrefix);

  app.use(cookieParser());

  const corsOrigins = config.get<string[]>('corsOrigins') || [];
  // If the list is empty or contains '*', reflect the request origin
  // (origin: true). This is the only way to "allow any origin" while
  // keeping credentials: true, since the CORS spec forbids the literal
  // wildcard '*' together with Access-Control-Allow-Credentials.
  const allowAnyOrigin =
    corsOrigins.length === 0 || corsOrigins.includes('*');
  app.enableCors({
    origin: allowAnyOrigin ? true : corsOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Serve locally stored uploads under /static.
  const uploadDir = config.get<string>('upload.localDir') || './uploads-store';
  app.useStaticAssets(join(process.cwd(), uploadDir), { prefix: '/static' });

  // Redis-backed Socket.IO adapter for multi-instance scaling.
  app.useWebSocketAdapter(new RedisIoAdapter(app, corsOrigins));

  // Swagger docs at /api/docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('HTSS Club Realtime API')
    .setDescription('Backend API for HTSS Club (chat, voice, wallet, social)')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document);

  const port = config.get<number>('port') || 3000;
  app.enableShutdownHooks();
  await app.listen(port);
  logger.log(`HTSS Club backend running on http://localhost:${port}`);
  logger.log(`Swagger docs at http://localhost:${port}/${apiPrefix}/docs`);
}

void bootstrap();

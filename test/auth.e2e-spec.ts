import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';

/**
 * Basic auth flow e2e test. Requires MongoDB (replica set) + Redis.
 * Run with: npm run test:e2e
 */
describe('Auth flow (e2e)', () => {
  let app: INestApplication;
  const unique = Date.now();
  const creds = {
    username: `tester_${unique}`,
    email: `tester_${unique}@example.com`,
    password: 'StrongP@ss1',
  };
  let accessToken: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers a new user', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send(creds)
      .expect(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.user.username).toBe(creds.username);
    expect(res.body.data.user.passwordHash).toBeUndefined();
    accessToken = res.body.data.accessToken;
  });

  it('rejects duplicate registration', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send(creds)
      .expect(409);
    expect(res.body.success).toBe(false);
  });

  it('logs in with email', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: creds.email, password: creds.password })
      .expect(200);
    expect(res.body.data.accessToken).toBeDefined();
  });

  it('rejects bad credentials', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: creds.email, password: 'wrong' })
      .expect(401);
  });

  it('returns the current user profile', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.data.email).toBe(creds.email);
    expect(res.body.data.balance).toBe(0);
  });

  it('blocks /me without a token', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
  });
});

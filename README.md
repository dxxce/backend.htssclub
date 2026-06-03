# HTSS Club Realtime Backend (NestJS)

Realtime backend for the HTSS Club: auth, social, servers/channels, realtime
chat, WebRTC voice signaling, wallet, uploads, notifications and admin tools.

Built with **NestJS 10 + MongoDB (Mongoose) + Redis + Socket.IO**, following
`backend-design-nestjs.md`.

## Tech stack

| Concern | Choice |
| --- | --- |
| Framework | NestJS 10 (TypeScript) |
| Database | MongoDB + Mongoose (transactions need a replica set) |
| Cache / pub-sub | Redis (voice presence, rate-limit, Socket.IO scaling) |
| Auth | JWT access + refresh (rotating), Passport, argon2 hashing |
| Realtime | `@nestjs/websockets` + socket.io (`/ws`, `/ws-voice`) |
| Validation | class-validator + global ValidationPipe |
| Uploads | Multer (memory) → local disk (`/static`) or S3/MinIO |
| Docs | Swagger at `/api/docs` |

## Prerequisites

- Node.js 18+ (tested on 22)
- MongoDB running as a **replica set** (required for multi-document
  transactions used by the wallet)
- Redis

The quickest way to get both is Docker:

```bash
docker compose up -d
```

This starts MongoDB as a single-node replica set (`rs0`) and Redis.

## Setup

```bash
npm install
cp .env.example .env   # adjust secrets / URIs
npm run start:dev
```

The API listens on `http://localhost:3000` with the global prefix `/api`.
Swagger UI: `http://localhost:3000/api/docs`.

## Environment

See `.env.example` for all variables. Key ones:

- `MONGO_URI` — must point at a replica set, e.g.
  `mongodb://127.0.0.1:27017/htss_club?replicaSet=rs0`
- `REDIS_URL` — e.g. `redis://127.0.0.1:6379`
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` — change these in production
- `CORS_ORIGINS` — comma-separated allowed origins
- `UPLOAD_DRIVER` — `local` (default) or `s3`

## Conventions

- **Response envelope:** every REST response is wrapped as
  `{ success: true, data }` or `{ success: false, error: { code, message } }`.
- **Pagination:** `?page=1&limit=20` → `{ items, total, page, limit, hasMore }`.
- **IDs:** Mongo `_id` is serialized to `id`; `passwordHash`/`refreshHash`/`__v`
  are stripped from JSON output.
- **Auth:** access token (15m) in `Authorization: Bearer <token>`; refresh
  token (7d) in the `refresh_token` httpOnly cookie, rotated on `/auth/refresh`.

## Module map

| Path | Responsibility |
| --- | --- |
| `auth/` | register / login / refresh / logout, sessions, password reset |
| `users/` | profile, presence, search, sessions |
| `wallet/` | balance, transactions, spend/transfer (atomic via Mongo tx) |
| `friends/` | requests, accept/decline, block/unblock |
| `servers/` | guilds, members, roles, invites |
| `channels/` | text/voice channels, voice member list |
| `messages/` | history + send/edit/delete (REST + broadcast) |
| `chat-gateway/` | `/ws` realtime chat, typing, presence |
| `voice-gateway/` | `/ws-voice` WebRTC signaling + Redis voice presence |
| `uploads/` | avatar + attachment uploads |
| `notifications/` | list/read + realtime push |
| `admin/` | account status, balance adjust, stats |

## WebSocket namespaces

- `/ws` — chat. Authenticate with `socket.handshake.auth.token = <accessToken>`.
  Rooms: `user:{id}`, `server:{id}`, `channel:{id}`.
- `/ws-voice` — voice signaling. Backend relays SDP offers/answers and ICE
  candidates between peers; voice membership is tracked in Redis.

## Wallet safety

All balance changes run inside a MongoDB transaction. Debits use an atomic
`findOneAndUpdate({ balance: { $gte: amount } }, { $inc: { balance: -amount } })`
guard so the balance can never go negative and races are impossible. Transfers
debit and credit inside a single transaction.

## Tests

```bash
npm test          # unit tests (no external services needed)
npm run test:e2e  # e2e auth flow (requires MongoDB replica set + Redis)
```

## Scaling

Socket.IO uses the `@socket.io/redis-adapter` so events broadcast across
multiple instances. Rate limiting uses `@nestjs/throttler`.

## Notes / next steps

- `wallet.confirmTopup()` is the hook a payment-gateway webhook should call
  after a successful payment. Wire it behind a signature-verified endpoint.
- The S3 upload driver is stubbed to fall back to local storage; plug in
  `@aws-sdk/client-s3` in `uploads.service.ts` to enable it.
- For voice groups larger than ~8 peers, consider an SFU (mediasoup/LiveKit)
  in place of mesh P2P.

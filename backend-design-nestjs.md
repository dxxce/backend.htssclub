# 🛠️ Thiết kế Backend API (NestJS) — HTSS Club Realtime

> **Dành cho AI agent:** File này là bản thiết kế để triển khai backend mới bằng **NestJS**. Hãy đọc kỹ phần [Tech Stack](#1-tech-stack--quy-ước) và [Data Model](#3-data-model-mongoose-schemas) trước, rồi triển khai từng module theo thứ tự trong [Lộ trình triển khai](#11-lộ-trình-triển-khai-cho-agent). Mỗi module gồm: Mongoose schema → DTO (class-validator) → Service → Controller (REST) hoặc Gateway (WebSocket). Tất cả route `[Guarded]` yêu cầu JWT hợp lệ.

---

## 1. Tech Stack & Quy ước

| Thành phần | Lựa chọn |
| --- | --- |
| Framework | NestJS 10+ (TypeScript) |
| Database | MongoDB + Mongoose (`@nestjs/mongoose`) |
| Cache / Pub-Sub | Redis (presence, rate-limit, scale WebSocket nhiều instance) |
| Auth | JWT (access + refresh), Passport (`passport-jwt`) |
| Realtime | `@nestjs/websockets` + `socket.io` |
| Voice | WebRTC — backend làm **signaling** (SFU tùy chọn: mediasoup/LiveKit) |
| Validation | `class-validator` + `class-transformer` (global `ValidationPipe`) |
| File upload | `@nestjs/platform-express` + Multer → lưu S3/MinIO hoặc local |
| Tài liệu | Swagger (`@nestjs/swagger`) tại `/api/docs` |

**Quy ước chung:**
- Base path: `/api`. WebSocket namespace: `/ws`.
- Response chuẩn: `{ success: boolean, data?: T, error?: { code, message } }`.
- Phân trang: query `?page=1&limit=20`, trả `{ items, total, page, limit, hasMore }`.
- Auth: access token (15 phút) trong header `Authorization: Bearer <token>`; refresh token (7 ngày) trong cookie `httpOnly` tên `refresh_token`.
- Mọi `id` là `ObjectId` của MongoDB (serialize ra string khi trả về client; dùng `_id` → map thành `id` qua transform).
- Timestamp ISO 8601 UTC (bật `{ timestamps: true }` cho mọi schema → có `createdAt`, `updatedAt`).
- **Giao dịch nhiều document** (vd cập nhật balance + ghi Transaction) dùng **MongoDB multi-document transaction** (`session.withTransaction`) — yêu cầu MongoDB chạy **replica set** (kể cả 1 node).

---

## 2. Cấu trúc thư mục

```
src/
├── main.ts                     # bootstrap, ValidationPipe, CORS, Swagger
├── app.module.ts               # MongooseModule.forRoot(MONGO_URI) + các feature module
├── database/                   # MongooseModule cấu hình, connection helper, transaction util
├── common/                     # guards, decorators, filters, interceptors
│   ├── guards/jwt-auth.guard.ts
│   ├── guards/ws-jwt.guard.ts
│   ├── decorators/current-user.decorator.ts
│   └── filters/all-exceptions.filter.ts
├── auth/                       # login, register, refresh, logout
├── users/                      # profile, balance, account status, presence
│   └── schemas/user.schema.ts
├── friends/                    # friend request / list / block
│   └── schemas/friend.schema.ts
├── servers/                    # "guild" (nhóm) chứa nhiều channel
│   └── schemas/{server.schema.ts, server-member.schema.ts}
├── channels/                   # text & voice channel CRUD
│   └── schemas/channel.schema.ts
├── messages/                   # gửi/sửa/xóa tin nhắn (REST + lịch sử)
│   └── schemas/message.schema.ts
├── chat-gateway/               # WebSocket: chat realtime, typing, presence
├── voice-gateway/              # WebSocket: WebRTC signaling cho voice channel
├── wallet/                     # balance, nạp/tiêu, lịch sử giao dịch
│   └── schemas/transaction.schema.ts
├── uploads/                    # ảnh đại diện, file đính kèm
└── notifications/              # thông báo realtime + đã đọc
    └── schemas/notification.schema.ts
```

> Mỗi feature module đăng ký schema qua `MongooseModule.forFeature([{ name, schema }])` và inject `@InjectModel(Name.name)` vào service.

---

## 3. Data Model (Mongoose Schemas)

> Dùng `@nestjs/mongoose` với decorator `@Schema`/`@Prop`. Bật `{ timestamps: true }` để có `createdAt`/`updatedAt`. Tham chiếu giữa collection dùng `Types.ObjectId` + `ref`. Định nghĩa `enum` bằng TypeScript `enum` rồi truyền vào `@Prop({ enum })`.

```typescript
// ── enums dùng chung ─────────────────────────────────────────────
export enum AccountStatus { ACTIVE = 'ACTIVE', BANNED = 'BANNED', SUSPENDED = 'SUSPENDED', PENDING = 'PENDING' }
export enum PresenceStatus { ONLINE = 'ONLINE', IDLE = 'IDLE', DND = 'DND', OFFLINE = 'OFFLINE' }
export enum ChannelType { TEXT = 'TEXT', VOICE = 'VOICE' }
export enum MemberRole { OWNER = 'OWNER', ADMIN = 'ADMIN', MEMBER = 'MEMBER' }
export enum FriendState { PENDING = 'PENDING', ACCEPTED = 'ACCEPTED', BLOCKED = 'BLOCKED' }
export enum TxType { TOPUP = 'TOPUP', SPEND = 'SPEND', REWARD = 'REWARD', REFUND = 'REFUND', TRANSFER = 'TRANSFER' }
```

### User (`users`)
```typescript
@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, index: true }) username: string;
  @Prop({ required: true, unique: true, index: true }) email: string;
  @Prop({ required: true }) passwordHash: string;          // argon2
  @Prop() displayName?: string;
  @Prop() avatarUrl?: string;
  @Prop({ default: 0, min: 0 }) balance: number;            // đơn vị xu (số nguyên)
  @Prop({ enum: AccountStatus, default: AccountStatus.ACTIVE }) status: AccountStatus;
  @Prop({ enum: PresenceStatus, default: PresenceStatus.OFFLINE }) presence: PresenceStatus;
  @Prop() lastSeenAt?: Date;
}
// index: { username: 1 }, { email: 1 }
```

### Session (`sessions`) — refresh token / multi-device
```typescript
@Schema({ timestamps: true })
export class Session {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true }) userId: Types.ObjectId;
  @Prop({ required: true }) refreshHash: string;            // băm refresh token
  @Prop() userAgent?: string;
  @Prop() ip?: string;
  @Prop({ required: true }) expiresAt: Date;                // TTL index để tự xóa
}
// TTL: schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
```

### Friend (`friends`)
```typescript
@Schema({ timestamps: true })
export class Friend {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) requesterId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) addresseeId: Types.ObjectId;
  @Prop({ enum: FriendState, default: FriendState.PENDING }) state: FriendState;
}
// unique compound: schema.index({ requesterId: 1, addresseeId: 1 }, { unique: true })
```

### Server (`servers`) — nhóm / guild
```typescript
@Schema({ timestamps: true })
export class Server {
  @Prop({ required: true }) name: string;
  @Prop() iconUrl?: string;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true }) ownerId: Types.ObjectId;
  @Prop() inviteCode?: string;                              // mã mời (unique, sparse)
}
// index: { inviteCode: 1 } unique sparse
```

### ServerMember (`server_members`)
```typescript
@Schema({ timestamps: true })
export class ServerMember {
  @Prop({ type: Types.ObjectId, ref: 'Server', required: true, index: true }) serverId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true }) userId: Types.ObjectId;
  @Prop({ enum: MemberRole, default: MemberRole.MEMBER }) role: MemberRole;
  @Prop({ default: () => new Date() }) joinedAt: Date;
}
// unique compound: schema.index({ serverId: 1, userId: 1 }, { unique: true })
```

### Channel (`channels`)
```typescript
@Schema({ timestamps: true })
export class Channel {
  @Prop({ type: Types.ObjectId, ref: 'Server', required: true, index: true }) serverId: Types.ObjectId;
  @Prop({ required: true }) name: string;
  @Prop({ enum: ChannelType, default: ChannelType.TEXT }) type: ChannelType;
  @Prop() topic?: string;
  @Prop({ default: 0 }) position: number;
  @Prop() userLimit?: number;                               // chỉ cho VOICE (0/null = không giới hạn)
}
```

### Message (`messages`)
```typescript
@Schema({ timestamps: true })
export class Message {
  @Prop({ type: Types.ObjectId, ref: 'Channel', required: true, index: true }) channelId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) authorId: Types.ObjectId;
  @Prop({ required: true }) content: string;
  @Prop({ type: [Object] }) attachments?: { url: string; type: string; name: string; size: number }[];
  @Prop({ type: Types.ObjectId, ref: 'Message' }) replyToId?: Types.ObjectId;
  @Prop() editedAt?: Date;
}
// index lịch sử: schema.index({ channelId: 1, _id: -1 })  // phân trang theo _id (mới→cũ)
```

### Transaction (`transactions`)
```typescript
@Schema({ timestamps: true })
export class Transaction {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true }) userId: Types.ObjectId;
  @Prop({ enum: TxType, required: true }) type: TxType;
  @Prop({ required: true }) amount: number;                 // dương = cộng, âm = trừ
  @Prop({ required: true }) balanceAfter: number;
  @Prop() reason?: string;
  @Prop() refId?: string;                                   // liên kết đơn/giao dịch ngoài
}
```

### Notification (`notifications`)
```typescript
@Schema({ timestamps: true })
export class Notification {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true }) userId: Types.ObjectId;
  @Prop({ required: true }) type: string;                   // FRIEND_REQUEST, MENTION, SYSTEM...
  @Prop({ type: Object }) payload: Record<string, any>;
  @Prop() readAt?: Date;
}
```

> **Transform khi serialize:** cấu hình `toJSON` để đổi `_id` → `id` và bỏ `__v`/`passwordHash`:
> ```typescript
> schema.set('toJSON', {
>   virtuals: true,
>   transform: (_, ret) => { ret.id = ret._id; delete ret._id; delete ret.__v; delete ret.passwordHash; },
> });
> ```

---

## 4. Auth (`/api/auth`)

| Method | Path | Body / Params | Mô tả |
| --- | --- | --- | --- |
| POST | `/register` | `RegisterDto { username, email, password, displayName? }` | Tạo user, trả access token + set cookie refresh. |
| POST | `/login` | `LoginDto { identifier, password }` (identifier = email hoặc username) | Đăng nhập, trả access token + refresh cookie. |
| POST | `/refresh` | (đọc cookie `refresh_token`) | Cấp access token mới (xoay vòng refresh). |
| POST | `/logout` `[Guarded]` | — | Thu hồi session hiện tại, xóa cookie. |
| POST | `/logout-all` `[Guarded]` | — | Thu hồi mọi session của user. |
| GET | `/me` `[Guarded]` | — | Hồ sơ user hiện tại (gồm balance, status). |
| POST | `/forgot-password` | `{ email }` | Gửi email reset (token hết hạn 30 phút). |
| POST | `/reset-password` | `{ token, newPassword }` | Đổi mật khẩu bằng token. |
| POST | `/change-password` `[Guarded]` | `{ oldPassword, newPassword }` | Đổi mật khẩu khi đã đăng nhập. |

**Lưu ý:** băm mật khẩu bằng `argon2` (ưu tiên) hoặc `bcrypt`. Tài khoản `BANNED`/`SUSPENDED` không được login (trả 403 kèm lý do).

---

## 5. Users & Presence (`/api/users`)

| Method | Path | Mô tả |
| --- | --- | --- |
| GET | `/:id` | Hồ sơ công khai (username, avatar, presence, status). |
| PATCH | `/me` `[Guarded]` | Cập nhật `displayName`, `avatarUrl`. |
| PATCH | `/me/presence` `[Guarded]` | Đặt presence: `ONLINE/IDLE/DND/OFFLINE`. |
| GET | `/me/sessions` `[Guarded]` | Danh sách thiết bị đang đăng nhập. |
| DELETE | `/me/sessions/:sessionId` `[Guarded]` | Đăng xuất thiết bị cụ thể. |
| GET | `/search?q=` `[Guarded]` | Tìm user theo username. |

**Account status** do admin quản lý (xem [Admin](#10-admin--moderation)). Presence được tự cập nhật bởi WebSocket (online khi kết nối, offline khi ngắt + cập nhật `lastSeenAt`).

---

## 6. Wallet / Balance (`/api/wallet`)
*Tất cả `[Guarded]`.*

| Method | Path | Body | Mô tả |
| --- | --- | --- | --- |
| GET | `/balance` | — | Số dư hiện tại. |
| GET | `/transactions?page=&limit=` | — | Lịch sử giao dịch. |
| POST | `/topup` | `{ amount, method }` | Tạo yêu cầu nạp (tích hợp cổng thanh toán → webhook xác nhận). |
| POST | `/spend` | `{ amount, reason, refId? }` | Trừ số dư (kiểm tra đủ tiền; **dùng transaction DB để tránh race**). |
| POST | `/transfer` | `{ toUserId, amount, note? }` | Chuyển xu cho user khác (atomic 2 chiều). |

**Quy tắc bắt buộc:** mọi thay đổi `balance` phải chạy trong **MongoDB transaction** (`connection.startSession()` → `session.withTransaction(...)`), trong đó: (1) cập nhật `User.balance` bằng toán tử nguyên tử `$inc` kèm điều kiện đủ tiền (`{ balance: { $gte: amount } }`), (2) ghi 1 bản `Transaction` với `balanceAfter`. Không bao giờ cho `balance < 0` (đã có `min: 0` trên schema + điều kiện `$gte`). Yêu cầu MongoDB chạy **replica set** để dùng transaction.

---

## 7. Friends (`/api/friends`)
*Tất cả `[Guarded]`.*

| Method | Path | Mô tả |
| --- | --- | --- |
| GET | `/` | Danh sách bạn (state ACCEPTED) kèm presence. |
| GET | `/requests` | Lời mời đến/đi đang chờ. |
| POST | `/request` `{ userId }` | Gửi lời mời kết bạn. |
| POST | `/accept` `{ requestId }` | Chấp nhận. |
| POST | `/decline` `{ requestId }` | Từ chối. |
| DELETE | `/:userId` | Hủy kết bạn. |
| POST | `/block` `{ userId }` | Chặn user. |
| DELETE | `/block/:userId` | Bỏ chặn. |

---

## 8. Servers & Channels

### 8.1 Servers (`/api/servers`) `[Guarded]`
| Method | Path | Mô tả |
| --- | --- | --- |
| POST | `/` `{ name, iconUrl? }` | Tạo server (người tạo = OWNER). |
| GET | `/` | Server mà user là thành viên. |
| GET | `/:id` | Chi tiết server + danh sách channel + member. |
| PATCH | `/:id` (ADMIN+) | Đổi tên/icon. |
| DELETE | `/:id` (OWNER) | Xóa server. |
| POST | `/:id/invite` (ADMIN+) | Tạo mã mời. |
| POST | `/join` `{ inviteCode }` | Tham gia bằng mã. |
| DELETE | `/:id/leave` | Rời server. |
| GET | `/:id/members` | Danh sách thành viên + role. |
| PATCH | `/:id/members/:userId/role` (OWNER/ADMIN) | Đổi role. |
| DELETE | `/:id/members/:userId` (ADMIN+) | Kick thành viên. |

### 8.2 Channels (`/api/servers/:serverId/channels`) `[Guarded]`
| Method | Path | Body | Mô tả |
| --- | --- | --- | --- |
| POST | `/` | `CreateChannelDto { name, type: TEXT\|VOICE, topic?, userLimit? }` | Tạo kênh text hoặc voice (ADMIN+). |
| GET | `/` | — | Danh sách kênh trong server. |
| PATCH | `/:channelId` | `{ name?, topic?, position?, userLimit? }` | Sửa kênh (ADMIN+). |
| DELETE | `/:channelId` | — | Xóa kênh (ADMIN+). |
| GET | `/:channelId/voice-members` | — | Ai đang trong kênh voice (đọc từ Redis presence). |

### 8.3 Messages (`/api/channels/:channelId/messages`) `[Guarded]`
| Method | Path | Body | Mô tả |
| --- | --- | --- | --- |
| GET | `/?before=&limit=` | — | Lịch sử tin nhắn (cursor `before` = messageId, mới→cũ). |
| POST | `/` | `{ content, attachments?, replyToId? }` | Gửi tin (cũng emit qua WebSocket). |
| PATCH | `/:messageId` | `{ content }` | Sửa (chỉ tác giả). |
| DELETE | `/:messageId` | — | Xóa (tác giả hoặc ADMIN+). |

> REST dùng cho **lịch sử & fallback**; gửi/nhận realtime đi qua WebSocket (mục 9). Khi POST qua REST, server vẫn broadcast `message:new` để các client khác nhận ngay.

---

## 9. WebSocket — Chat realtime (`namespace /ws`)

**Kết nối:** client gửi access token qua `socket.handshake.auth.token`. `WsJwtGuard` xác thực; gắn `socket.data.user`. Khi connect → set presence ONLINE + join room cá nhân `user:{id}` và mọi `server:{id}` user thuộc về.

**Rooms:** `channel:{channelId}` (chat), `server:{serverId}` (sự kiện chung), `user:{userId}` (riêng tư).

### Client → Server (emit)
| Event | Payload | Mô tả |
| --- | --- | --- |
| `channel:join` | `{ channelId }` | Vào room kênh text để nhận tin realtime. |
| `channel:leave` | `{ channelId }` | Rời room. |
| `message:send` | `{ channelId, content, attachments?, replyToId? }` | Gửi tin nhắn (server lưu DB rồi broadcast). |
| `message:edit` | `{ messageId, content }` | Sửa. |
| `message:delete` | `{ messageId }` | Xóa. |
| `typing:start` | `{ channelId }` | Báo đang gõ. |
| `typing:stop` | `{ channelId }` | Dừng gõ. |
| `presence:update` | `{ status }` | Đổi trạng thái hiển thị. |

### Server → Client (broadcast)
| Event | Payload | Mô tả |
| --- | --- | --- |
| `message:new` | `Message` | Tin mới trong kênh. |
| `message:updated` | `Message` | Tin được sửa. |
| `message:deleted` | `{ messageId, channelId }` | Tin bị xóa. |
| `typing` | `{ channelId, userId, isTyping }` | Ai đang gõ. |
| `presence:changed` | `{ userId, presence }` | Bạn bè/thành viên đổi trạng thái. |
| `notification:new` | `Notification` | Thông báo realtime. |
| `error` | `{ code, message }` | Lỗi cho event vừa gửi. |

---

## 10. WebSocket — Voice chat / WebRTC signaling (`namespace /ws-voice`)

Backend làm **signaling server**. Mặc định P2P (mesh) cho nhóm nhỏ; với nhóm lớn (>8 người) khuyến nghị SFU (mediasoup hoặc LiveKit) — phần này tách module riêng `voice-gateway`.

**Trạng thái voice** (ai đang ở kênh nào) lưu trong **Redis**: `voice:channel:{channelId} → Set<userId>` và `voice:user:{userId} → channelId`.

### Client → Server
| Event | Payload | Mô tả |
| --- | --- | --- |
| `voice:join` | `{ channelId }` | Vào kênh voice. Server kiểm tra `userLimit`, thêm vào Redis, trả danh sách peer hiện có. |
| `voice:leave` | `{ channelId }` | Rời kênh. |
| `voice:offer` | `{ toUserId, sdp }` | Gửi SDP offer tới peer. |
| `voice:answer` | `{ toUserId, sdp }` | Gửi SDP answer. |
| `voice:ice` | `{ toUserId, candidate }` | Trao đổi ICE candidate. |
| `voice:state` | `{ muted, deafened, speaking }` | Cập nhật trạng thái mic/loa. |

### Server → Client
| Event | Payload | Mô tả |
| --- | --- | --- |
| `voice:peers` | `{ channelId, peers: VoiceMember[] }` | Danh sách người đang trong kênh (khi vừa join). |
| `voice:user-joined` | `{ channelId, user }` | Có người mới vào. |
| `voice:user-left` | `{ channelId, userId }` | Có người rời. |
| `voice:offer` / `voice:answer` / `voice:ice` | `{ fromUserId, ... }` | Chuyển tiếp signaling giữa các peer. |
| `voice:state-changed` | `{ userId, muted, deafened, speaking }` | Cập nhật mic/loa của thành viên. |

**Dọn dẹp:** khi socket ngắt, tự gỡ user khỏi kênh voice + broadcast `voice:user-left`.

---

## 11. Uploads (`/api/uploads`) `[Guarded]`
| Method | Path | Mô tả |
| --- | --- | --- |
| POST | `/avatar` (multipart `file`) | Upload avatar (chỉ ảnh, ≤ 5MB), trả `url`. |
| POST | `/attachment` (multipart `file`) | Upload file đính kèm tin nhắn (≤ 25MB), trả `{ url, type, name, size }`. |

Kiểm tra MIME + giới hạn dung lượng; lưu S3/MinIO, trả URL công khai (hoặc presigned).

---

## 12. Notifications (`/api/notifications`) `[Guarded]`
| Method | Path | Mô tả |
| --- | --- | --- |
| GET | `/?page=&limit=` | Danh sách thông báo. |
| GET | `/unread-count` | Số thông báo chưa đọc. |
| PATCH | `/:id/read` | Đánh dấu đã đọc. |
| PATCH | `/read-all` | Đánh dấu tất cả đã đọc. |

Mọi thông báo mới cũng được đẩy realtime qua event `notification:new` tới room `user:{id}`.

---

## 13. Admin & Moderation (`/api/admin`) `[Guarded + Role ADMIN]`
| Method | Path | Mô tả |
| --- | --- | --- |
| PATCH | `/users/:id/status` `{ status, reason? }` | Đặt `ACTIVE/BANNED/SUSPENDED`. Ban → thu hồi mọi session + ngắt WebSocket. |
| POST | `/users/:id/balance` `{ amount, reason }` | Cộng/trừ xu thủ công (ghi Transaction `REWARD/REFUND`). |
| GET | `/stats` | Thống kê: tổng user, online, tin nhắn/ngày... |

---

## 14. Bảo mật & Vận hành (bắt buộc)

- **Guards:** `JwtAuthGuard` (REST), `WsJwtGuard` (WebSocket), `RolesGuard` cho route theo role server/admin.
- **Rate limit:** `@nestjs/throttler` cho auth (5 req/phút/IP) và gửi tin nhắn (chống spam, dùng Redis store).
- **Validation:** global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.
- **CORS:** chỉ cho phép origin của Launcher/web.
- **Kiểm soát quyền kênh:** trước khi join/đọc/ghi channel, kiểm tra user là `ServerMember` của server chứa kênh đó.
- **Scale WebSocket:** dùng `@socket.io/redis-adapter` để broadcast xuyên nhiều instance.
- **Số dư:** mọi thao tác qua MongoDB transaction + `$inc` có điều kiện, không tin client gửi `amount` âm.
- **Secrets:** đọc từ `.env` (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `MONGO_URI`, `REDIS_URL`, S3 keys).
- **Logging & lỗi:** `AllExceptionsFilter` trả format chuẩn; log có request id.

---

## 15. Lộ trình triển khai (cho agent)

Triển khai **tuần tự**, mỗi bước có thể test độc lập:

1. **Khởi tạo:** NestJS project, `MongooseModule.forRoot(MONGO_URI)` (MongoDB replica set), Redis, global `ValidationPipe`, Swagger, `AllExceptionsFilter`, transform `toJSON` (`_id` → `id`).
2. **Auth module:** register/login/refresh/logout + JWT guard + `@CurrentUser()` decorator.
3. **Users + Presence:** profile, cập nhật, search.
4. **Wallet:** balance + transactions + spend/transfer (MongoDB transaction + `$inc` có điều kiện).
5. **Friends:** request/accept/block.
6. **Servers + Channels:** CRUD server, tạo kênh TEXT/VOICE, phân quyền role.
7. **Messages REST:** lịch sử + gửi/sửa/xóa.
8. **Chat Gateway (`/ws`):** `WsJwtGuard`, join/leave room, `message:send` → lưu DB + broadcast, typing, presence.
9. **Voice Gateway (`/ws-voice`):** join/leave + WebRTC signaling + trạng thái Redis.
10. **Uploads + Notifications.**
11. **Admin/Moderation** + rate-limit + Redis adapter để scale.

> Sau mỗi module: viết e2e test cơ bản (auth flow, gửi tin nhắn qua socket, join voice). Cập nhật Swagger. Đồng bộ DTO type sang frontend nếu cần.

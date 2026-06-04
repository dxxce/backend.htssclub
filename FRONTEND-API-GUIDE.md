# 📘 HTSS Club — Hướng dẫn Frontend đầy đủ (REST + Realtime)

> Tài liệu tổng hợp MỌI endpoint REST và sự kiện realtime của backend.
> Dùng kèm `FRONTEND-REALTIME-SYNC.md` (giải thích chi tiết từng nhóm event).
> Base REST: `/api` · Header: `Authorization: Bearer <accessToken>`
> Envelope: `{ success, data }` hoặc `{ success, error: { code, message } }`
> Phân trang: `?page=1&limit=20` → `{ items, total, page, limit, hasMore }`

---

## 0. Kết nối & xác thực

### REST auth
```
POST /api/auth/register   { username, email, password, displayName? }
POST /api/auth/login      { identifier, password }   // identifier = email|username
POST /api/auth/refresh    { refreshToken? }          // hoặc đọc cookie refresh_token
POST /api/auth/logout                                 [auth]
POST /api/auth/logout-all                             [auth]
GET  /api/auth/me                                     [auth]
POST /api/auth/forgot-password  { email }
POST /api/auth/reset-password   { token, newPassword }
POST /api/auth/change-password  { oldPassword, newPassword }   [auth]
```
- register/login/refresh trả `{ accessToken, refreshToken, refreshExpiresAt, user }`.
- accessToken sống 15 phút; hết hạn gọi `/auth/refresh`.

### 2 Socket.IO namespace
```ts
import { io } from 'socket.io-client';
const chat  = io(`${BASE}/ws`,       { transports:['websocket'], auth:{ token: accessToken } });
const voice = io(`${BASE}/ws-voice`, { transports:['websocket'], auth:{ token: accessToken } });
```
- `chat` tự join `user:{id}` + mọi `server:{id}` → nhận hết event server/DM/friend/wallet.
- `voice` chỉ mở khi user vào kênh thoại để nói/stream.

---

## 1. Users & Profile
```
GET   /api/users/:id            [auth]  -> profile + friendStatus + friendRequestId
GET   /api/users/search?q=      [auth]  -> mỗi kết quả kèm friendStatus
PATCH /api/users/me             [auth]  { displayName?, avatarUrl?, bio?, statusMessage? }
PATCH /api/users/me/presence    [auth]  { status: ONLINE|IDLE|DND|OFFLINE }
GET   /api/users/me/sessions    [auth]
DELETE /api/users/me/sessions/:sessionId  [auth]
```
User object: `{ id, username, displayName, avatarUrl, bio, statusMessage, presence, status, lastSeenAt, e2ePublicKey, friendStatus?, friendRequestId? }`

**Events** (room server / cá nhân):
```ts
chat.on('user:updated', ({ serverId, user }) => {}); // name/avatar/bio/statusMessage đổi
chat.on('presence:changed', ({ userId, presence }) => {});
```

---

## 2. Friends
```
GET    /api/friends                 [auth]  danh sách bạn
GET    /api/friends/requests        [auth]  { incoming, outgoing }
GET    /api/friends/status/:userId  [auth]  trạng thái quan hệ
POST   /api/friends/request  { userId }
POST   /api/friends/accept   { requestId }
POST   /api/friends/decline  { requestId }
POST   /api/friends/block    { userId }
DELETE /api/friends/block/:userId
DELETE /api/friends/:userId          hủy kết bạn
```
friendStatus: `NONE | FRIENDS | REQUEST_SENT | REQUEST_RECEIVED | BLOCKED | BLOCKED_BY | SELF`

**Events** (room cá nhân):
```ts
chat.on('friend:request-received', ({ fromUserId, from, requestId }) => {});
chat.on('friend:accepted', ({ fromUserId, from }) => {});
chat.on('friend:declined', ({ fromUserId, from }) => {});
chat.on('friend:removed',  ({ fromUserId, from }) => {});
```

---

## 3. Servers & Members
```
POST   /api/servers  { name, iconUrl? }
GET    /api/servers                          danh sách server của tôi
GET    /api/servers/:id                      chi tiết (channels + members)
PATCH  /api/servers/:id  { name?, iconUrl? }            (ADMIN+)
DELETE /api/servers/:id                                 (OWNER)
POST   /api/servers/join  { inviteCode }
POST   /api/servers/:id/invite                          (ADMIN+)
DELETE /api/servers/:id/invite                          (ADMIN+)
DELETE /api/servers/:id/leave
GET    /api/servers/:id/members
PATCH  /api/servers/:id/members/:userId/role  { role }  (OWNER/ADMIN)
DELETE /api/servers/:id/members/:userId                 kick (ADMIN+)
POST   /api/servers/:id/transfer-ownership { newOwnerId } (OWNER)
POST   /api/servers/:id/members/:userId/ban { reason? } (ADMIN+)
DELETE /api/servers/:id/bans/:userId                    unban (ADMIN+)
GET    /api/servers/:id/bans                            (ADMIN+)
PATCH  /api/servers/:id/members/:userId/nickname { nickname? }
POST   /api/servers/:id/announce  { message }           (ADMIN+)  ⚠️ field là `message`
```

**Events** (room `server:{id}`):
```ts
chat.on('server:updated', (server) => {});
chat.on('server:deleted', ({ serverId }) => {});
chat.on('server:member-joined',  ({ serverId, userId, member }) => {}); // member card đầy đủ
chat.on('server:member-left',    ({ serverId, userId }) => {});
chat.on('server:member-updated', ({ serverId, userId, role?, nickname? }) => {});
chat.on('server:member-banned',  ({ serverId, userId, reason }) => {});
chat.on('server:you-were-banned',({ serverId, reason }) => {});
chat.on('server:ownership-transferred', ({ serverId, from, to }) => {});
chat.on('server:announcement', ({ serverId, message, byUserId, at }) => {});
```

---

## 4. Channels
```
POST   /api/servers/:serverId/channels  { name, type: TEXT|VOICE, topic?, userLimit? }  (ADMIN+)
GET    /api/servers/:serverId/channels        (VOICE channel kèm voiceMembers[])
PATCH  /api/servers/:serverId/channels/reorder { items: [{ channelId, position }] } (ADMIN+)
PATCH  /api/channels/:channelId  { name?, topic?, position?, userLimit? }  (ADMIN+)
DELETE /api/channels/:channelId                (ADMIN+, cascade message + kick voice)
GET    /api/channels/:channelId/voice-members  VoiceMember[]
```
**Events** (room `server:{id}`):
```ts
chat.on('channel:created',   (channel) => {});
chat.on('channel:updated',   (channel) => {});
chat.on('channel:deleted',   ({ serverId, channelId }) => {});
chat.on('channel:reordered', ({ serverId, channels }) => {});
```

---

## 5. Messages (chat trong kênh)
```
GET    /api/channels/:channelId/messages?before=&limit=
POST   /api/channels/:channelId/messages  { content?, attachments?, replyToId? }
PATCH  /api/channels/:channelId/messages/:messageId  { content }
DELETE /api/channels/:channelId/messages/:messageId
POST   /api/channels/:channelId/messages/:messageId/reactions   { emoji }
DELETE /api/channels/:channelId/messages/:messageId/reactions   { emoji }
```
Message object kèm: `author`, `replyTo` (null nếu tin gốc bị xóa),
`reactions: [{ emoji, count, userIds, me }]`, `attachments: [{ url, type, name, size, category }]`.
- `content` có thể RỖNG nếu có ≥1 attachment.

**WS (qua `chat`)**
```ts
chat.emit('channel:join',  { channelId });   chat.emit('channel:leave', { channelId });
chat.emit('message:send',  { channelId, content?, attachments?, replyToId? });
chat.emit('message:edit',  { messageId, content });
chat.emit('message:delete',{ messageId });
chat.emit('typing:start',  { channelId });   chat.emit('typing:stop', { channelId });

chat.on('message:new', (m) => {});       chat.on('message:updated', (m) => {});
chat.on('message:deleted', ({ messageId, channelId }) => {});
chat.on('typing', ({ channelId, userId, isTyping }) => {});
chat.on('reaction:added',   ({ channelId, messageId, emoji, userId }) => {});
chat.on('reaction:removed', ({ channelId, messageId, emoji, userId }) => {});
```

---

## 6. Uploads (đính kèm)
```
POST /api/uploads/avatar      (multipart file, ảnh ≤5MB)
POST /api/uploads/attachment  (multipart file) -> { url, type, name, size, category }
```
- category: IMAGE | VIDEO | AUDIO | FILE. Video ≤200MB, còn lại ≤25MB.
- Upload trước → gắn vào `attachments` khi gửi message/DM.

---

## 7. Voice + Streaming (LiveKit SFU — KHÔNG mesh P2P)
```ts
// vào kênh thoại:
voice.emit('voice:join', { channelId }, (resp) => {
  // resp.livekit = { url, token, room, identity } -> dùng livekit-client kết nối
  // resp.peers   = VoiceMember[]
});
voice.emit('voice:leave', { channelId });
voice.emit('voice:token', { channelId });          // xin lại token
voice.emit('voice:state', { muted?, deafened?, speaking? });
voice.emit('stream:start', { source: 'screen'|'camera' });  // sau khi publish track lên LiveKit
voice.emit('stream:stop',  {});

voice.on('voice:peers', ({ channelId, peers }) => {});
voice.on('voice:user-joined', ({ channelId, user }) => {});
voice.on('voice:user-left',   ({ channelId, userId }) => {});
voice.on('voice:state-changed', ({ userId, muted, deafened, speaking, streaming }) => {});
voice.on('stream:started', ({ channelId, userId, user, source }) => {});
voice.on('stream:stopped', ({ channelId, userId }) => {});
voice.on('voice:channel-closed', ({ channelId }) => {});   // kênh bị xóa
```
**Occupancy cho người NGOÀI phòng** (trên `chat`, room server):
```ts
chat.on('voice:channel-joined', ({ serverId, channelId, member }) => {});
chat.on('voice:channel-left',   ({ serverId, channelId, userId }) => {});
chat.on('voice:channel-state',  ({ serverId, channelId, userId, muted, deafened, streaming }) => {});
```
VoiceMember = `{ userId, user:{id,username,displayName,avatarUrl}, muted, deafened, speaking, streaming }`

---

## 8. Wallet (ví xu)
```
GET  /api/wallet/balance                 [auth]
GET  /api/wallet/transactions?page=&limit=
POST /api/wallet/topup    { amount, method }
POST /api/wallet/spend    { amount, reason, refId? }
POST /api/wallet/transfer { toUserId, amount, note? }   -> { transferId, fromUserId, toUserId, amount, note, createdAt }
GET  /api/wallet/transfers/:transferId                  chi tiết (chỉ người trong cuộc)
```
- `transfer` KHÔNG trả số dư 2 bên — chỉ trả `transferId` + tóm tắt. Số dư mới
  của riêng mình đến qua event `wallet:transaction`.
- `GET /wallet/transfers/:transferId` (chỉ người gửi/nhận) trả:
  `{ transferId, amount, note, from, to, direction: 'IN'|'OUT', myBalanceAfter,
     myTransactionId, createdAt }` — `myBalanceAfter` chỉ là số dư của CHÍNH bạn,
  không lộ số dư người kia.
**Event** (room cá nhân):
```ts
chat.on('wallet:transaction', ({ balance, transaction }) => {});
// balance = số dư mới; transaction.amount > 0 = nhận, < 0 = trừ
```

---

## 9. Notifications
```
GET   /api/notifications?page=&limit=
GET   /api/notifications/unread-count
PATCH /api/notifications/:id/read
PATCH /api/notifications/read-all
```
```ts
chat.on('notification:new', (notification) => {});
```

---

## 10. Direct Messages (kiểu Discord: TLS + mã hóa at-rest)
> Truyền qua TLS, lưu mã hóa at-rest trong DB. Server ĐỌC ĐƯỢC nội dung
> (tìm kiếm/kiểm duyệt) — KHÔNG phải E2E. Client gửi/nhận plaintext bình thường,
> KHÔNG cần quản lý khóa.
```
GET    /api/dm/conversations                  inbox + unread
POST   /api/dm/conversations  { toUserId }     mở/lấy hội thoại
GET    /api/dm/conversations/:id/messages?before=&limit=
PATCH  /api/dm/conversations/:id/read
POST   /api/dm/messages  { toUserId, content?, attachments?, replyToId? }
PATCH  /api/dm/messages/:messageId  { content }   (người gửi)
DELETE /api/dm/messages/:messageId                (người gửi)
```
**WS (qua `chat`)**
```ts
chat.emit('dm:send', { toUserId, content?, attachments?, replyToId? }, (msg) => {});
chat.emit('dm:typing:start', { conversationId });
chat.emit('dm:typing:stop',  { conversationId });
chat.emit('dm:read', { conversationId });

chat.on('dm:new',     ({ conversationId, message }) => {});  // message.content = plaintext
chat.on('dm:updated', ({ conversationId, message }) => {});
chat.on('dm:read',    ({ conversationId, byUserId, at }) => {});
chat.on('dm:typing',  ({ conversationId, userId, isTyping }) => {});
chat.on('dm:deleted', ({ conversationId, messageId }) => {});
```

---

## 11. Admin (cần user.isAdmin)
```
PATCH /api/admin/users/:id/status   { status, reason? }   ACTIVE|BANNED|SUSPENDED
POST  /api/admin/users/:id/balance  { amount, reason }    cộng/trừ xu thủ công
GET   /api/admin/stats
```

---

## Nguyên tắc vàng cho Frontend
1. **Store trung tâm theo id**: lưu user/server/channel/message theo `id` trong store,
   component render từ store. Khi nhận event realtime → cập nhật store → tự re-render.
   ĐỪNG "đóng băng" name/avatar vào từng dòng tin.
2. **Optimistic UI**: reaction, gửi tin, presence → cập nhật ngay, đồng bộ lại theo event.
3. **Rate limit**: auth 5 req/phút/IP; gửi tin/DM có giới hạn → tránh spam.
4. **DM (kiểu Discord)**: TLS + mã hóa at-rest; server đọc được nội dung. Client
   gửi/nhận plaintext, KHÔNG cần quản lý khóa.
5. **Voice/Stream**: media qua LiveKit SDK; backend chỉ là control plane.

---

## 12. Level / XP / Rank / Leaderboard

> **Level/XP** và **Rank** là HAI hệ thống ĐỘC LẬP:
> - Level/XP: kiếm XP (nhắn tin...), level càng cao càng cần nhiều XP.
> - Rank: dựa trên Rank Points (RP) riêng, có tier/division kiểu game.
>   KHÔNG suy ra từ XP/level.

User object kèm: `level`, `xp`, `rankPoints`, và `rank` (tier object).

### REST
```
GET /api/users/me/level              progress XP của tôi
GET /api/users/:id/level             progress XP người khác
GET /api/users/me/rank               rank (tier/division) của tôi
GET /api/users/:id/rank              rank người khác
GET /api/leaderboard?type=xp|coins|rank&limit=50   1 bảng
GET /api/leaderboard/both?limit=50                  cả 3 bảng: { xp[], coins[], rank[] }
GET /api/leaderboard/me?type=xp|coins|rank          hạng của tôi
```

**Level progress** (`/users/me/level`):
```jsonc
{ "level": 5, "xp": 1000, "xpIntoLevel": 0, "xpForNextLevel": 500,
  "xpToNextLevel": 500,    // 👈 còn cần bao nhiêu XP để lên cấp
  "progress": 0.0,         // 0..1 để vẽ thanh
  "style": {               // 👈 màu + hình dáng theo mốc 10 level
    "bracket": 0, "name": "Học Viên", "minLevel": 1, "maxLevel": 10,
    "shape": "circle", "color": "#22C55E", "colorSecondary": "#86EFAC", "glow": false
  }
}
```
Mốc level (mỗi 10 level đổi màu + hình): 1-10 Tân Binh (tròn xám) → 11-20 Học Viên
→ 21-30 Chiến Binh (vuông) → ... → 91-100 Á Thần (sao) → 101+ Thần Thoại (vương miện).
`shape` ∈ circle|square|shield|hexagon|star|crown. Frontend chọn asset/màu theo `style`.

**Rank** (`/users/me/rank`) — tier/division kiểu game, kèm màu + hình:
```jsonc
{ "tier": "GOLD", "tierName": "Vàng", "tierIndex": 2,
  "division": 2, "divisionLabel": "II", "label": "Vàng II",
  "rp": 850, "rpIntoDivision": 50, "rpForNextStep": 100,
  "rpToNextStep": 50,      // 👈 còn cần bao nhiêu RP để thăng hạng
  "progress": 0.5, "isApex": false,
  "shape": "shield", "color": "#F59E0B", "colorSecondary": "#FCD34D", "glow": false
}
```
Tiers: Đồng → Bạc → Vàng (shield) → Bạch Kim → Kim Cương (gem) → Cao Thủ →
Đại Cao Thủ (crown) → Thách Đấu (wings, apex). Mỗi tier có màu/hình riêng.

**Leaderboard entry**:
```jsonc
{ "rank": 1, "userId", "user": {...},
  "level": 5, "xp": 1000, "coins": 50, "rankPoints": 850,
  "tier": { ...rank object... },     // tier/division
  "score": 1000 }                    // theo `type` đang xem
```

### Realtime
```ts
// XP
chat.on('level:xp', ({ level, xp, xpToNextLevel, progress, gained, reason }) => {});
chat.on('level:up', ({ level, previousLevel, xp, serverId?, userId? }) => {});
// Rank (RP)
chat.on('rank:changed',  ({ rank, delta, reason }) => {});   // RP thay đổi
chat.on('rank:promoted', ({ from, to, rank }) => {});         // thăng hạng
chat.on('rank:demoted',  ({ from, to, rank }) => {});         // tụt hạng
```
- Notification persistent: `LEVEL_UP`, `RANK_UP`.

### Cách kiếm
- XP: gửi tin nhắn = +5 XP (tối đa 1 lần/60s).
- RP: do backend cấp qua `LevelingService.addRankPoints` (vd thắng hoạt động đấu);
  hiện chưa gắn nguồn tự động — gọi từ logic game khi có.


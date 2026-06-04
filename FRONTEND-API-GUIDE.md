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
- `author` (và `replyTo.author`) là card đầy đủ kèm **level + rank**:
  `{ id, username, displayName, avatarUrl, level, levelStyle, rank }` → render
  huy hiệu level/rank ngay trên mỗi tin nhắn.

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
>
> **Card người dùng ở MỌI nơi đều kèm level + rank** (message author,
> replyTo.author, DM from/otherUser, voice member, server member...):
> `{ id, username, displayName, avatarUrl, level, levelStyle, rank }`.
> Frontend render huy hiệu level/rank ngay trên mỗi tin nhắn / avatar.

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


---

## 13. 🎮 Caro 1v1 (Cờ caro / Gomoku) — game xếp hình có rank

> Game cờ caro 1v1 server-authoritative: bàn **15×15**, ai nối đủ **5 quân**
> liền (ngang/dọc/chéo) thì thắng. Trận **ranked** ăn/trừ **RP** (rank points)
> theo công thức ELO → ảnh hưởng trực tiếp tới hệ thống Rank (mục 12).
> Server giữ toàn bộ logic + đồng hồ; client chỉ gửi nước đi và vẽ lại.

### 13.1 Namespace Socket.IO riêng `/ws-caro`
```ts
import { io } from 'socket.io-client';
const caro = io(`${BASE}/ws-caro`, { transports: ['websocket'], auth: { token: accessToken } });
```
- Khi connect, socket tự join room cá nhân `caro-user:{id}` → nhận `caro:matched`
  khi được ghép cặp dù chưa vào room trận nào.
- Mỗi trận có room `caro:{gameId}`; client phải `caro:join` để nhận update realtime.

### 13.2 REST (đọc trạng thái / lịch sử)
```
GET /api/games/caro/active            [auth]  -> trận ACTIVE hiện tại của tôi (để reconnect), null nếu không có
GET /api/games/caro/history?limit=20  [auth]  -> danh sách trận đã kết thúc (mới nhất trước, tối đa 50)
GET /api/games/caro/:gameId           [auth]  -> trạng thái 1 trận theo id
```

### 13.3 Hình dạng `GameView` (trả về ở mọi nơi: ack, REST, event)
```jsonc
{
  "id": "game_id",
  "boardSize": 15,
  "board": [0,0,1,2,...],          // mảng phẳng 225 ô: 0 trống, 1 = X, 2 = O
  "moves": [ { "by": 1, "row": 7, "col": 0, "at": "..." } ],
  "turn": 1,                        // 1 = X đi, 2 = O đi
  "status": "ACTIVE",               // ACTIVE | FINISHED | ABORTED
  "ranked": true,
  "mode": "RANKED",                 // RANKED (RP) | WAGER (cược xu) | CASUAL (không gì)
  "betAmount": 0,                   // số xu mỗi người cược (WAGER)
  "pot": 0,                         // tổng tiền cược (người thắng lấy hết)
  "roomId": null,                   // id phòng lobby nếu tạo từ room
  "players": {
    "X": { "id": "u1", "username": "...", "displayName": "...", "avatarUrl": "..." },
    "O": { "id": "u2", "username": "...", "displayName": "...", "avatarUrl": "..." }
  },
  "winner": "u1",                   // null khi hòa/đang chơi
  "endReason": "WIN",               // WIN | RESIGN | TIMEOUT | DISCONNECT | DRAW | ABORTED | null
  "winningLine": [102,103,104,105,106],  // chỉ số phẳng của 5 ô thắng (để tô sáng), null nếu chưa kết thúc
  "rpChange": { "u1": 16, "u2": -16 },   // RP +/- mỗi người khi trận ranked kết thúc, null khi chưa xong
  "turnSeconds": 30                 // giới hạn thời gian mỗi nước đi
}
```
> Quy ước toạ độ: `index = row * 15 + col`. **X luôn đi trước** (mark 1).

### 13.4 Ghép trận (matchmaking xếp hạng) + đếm số người đang tìm
```ts
// (Tuỳ chọn) Vào "sảnh" để nhận số người đang tìm trận realtime mà KHÔNG xếp hàng
caro.emit('caro:lobby:join', {}, (ack) => { /* { searching, players } */ });
caro.emit('caro:lobby:leave', {}, () => {});
// Hỏi nhanh số người + danh sách người đang tìm trận bất cứ lúc nào
caro.emit('caro:queue:count', {}, ({ searching, players }) => {});

// Số người đang tìm trận thay đổi -> phát tới mọi người trong sảnh + đang xếp hàng
caro.on('caro:queue:count', ({ searching, players }) => updateSearching(searching, players));

// Vào hàng chờ ghép trận ranked
caro.emit('caro:queue:join', {}, (ack) => {
  // ack = { queued: true, queueSize, searching, players } nếu chưa có đối thủ
  // hoặc { matched: true, gameId } nếu được ghép ngay với người đang chờ
});

// Rời hàng chờ
caro.emit('caro:queue:leave', {}, (ack) => { /* { left: true, searching } */ });

// Khi backend ghép được cặp, CẢ HAI người nhận:
caro.on('caro:matched', (game /* GameView */) => {
  // -> điều hướng vào màn chơi, rồi gọi caro:join để vào room nhận update
});
```
- Ghép theo RP gần nhất (Redis sorted-set, hoạt động đa-instance). Quick-match luôn RANKED.
- Ai đi trước (X) là ngẫu nhiên.
- **`searching`** = số người đang xếp hàng quick-match. Hiện badge "🔍 N người đang tìm trận".
- **`players`** = danh sách người đang chờ, kèm **rank** để hiển thị:
```jsonc
[
  { "userId": "u1", "rankPoints": 1500,
    "user": { "id": "u1", "username": "...", "displayName": "...", "avatarUrl": "...",
              "level": 12, "levelStyle": {...}, "rank": { "label": "Vàng II", "tierIndex": 2, ... } } }
]
```

### 13.5 Phòng cược xu (WAGER room) — Caro 1v1
> Tạo phòng, đặt mức cược tuỳ ý. Khi tạo/join, xu bị **trừ tạm (escrow)** vào pot.
> Người **thắng lấy toàn bộ pot**; **hòa** thì hoàn lại cược cho cả 2. KHÔNG tính RP.
> Caro luôn 2 người (min=max=2).
```ts
// Tạo phòng (host tự vào phòng + bị trừ cược ngay). betAmount=0 -> phòng thường (CASUAL).
caro.emit('caro:room:create', { betAmount: 100, isPrivate: false, name: 'Phòng của tôi' },
  (room /* RoomView */) => {});

// Vào phòng bằng id hoặc code (bị trừ cược ngay nếu WAGER)
caro.emit('caro:room:join', { roomId } /* hoặc { code: 'CR-1A2B' } */, (room) => {});

// Sẵn sàng / huỷ sẵn sàng
caro.emit('caro:room:ready', { roomId, ready: true }, (room) => {});

// Host bắt đầu (cần đủ người + tất cả người không phải host đã ready)
caro.emit('caro:room:start', { roomId }, (ack) => { /* { gameId } */ });

// Rời phòng (hoàn cược). Nếu host rời -> phòng huỷ, mọi người được hoàn cược.
caro.emit('caro:room:leave', { roomId }, (ack) => { /* { left, cancelled } */ });

// Sự kiện trong room `caro-room:{roomId}`
caro.on('caro:room:updated', (room /* RoomView */) => renderLobby(room));
caro.on('caro:room:started', ({ roomId, gameId }) => goToGame(gameId));
caro.on('caro:room:closed',  ({ roomId, reason }) => leaveLobby()); // reason: HOST_LEFT
```
`RoomView`:
```jsonc
{
  "id": "room_id", "game": "CARO", "mode": "WAGER", "code": "CR-1A2B",
  "isPrivate": false, "name": "Phòng của tôi", "hostId": "u1",
  "betAmount": 100, "pot": 200, "minPlayers": 2, "maxPlayers": 2,
  "status": "WAITING",            // WAITING | STARTING | IN_PROGRESS | CLOSED
  "gameId": null,                 // có sau khi start
  "members": [
    { "userId": "u1", "user": {id,username,displayName,avatarUrl,level,rank,levelStyle},
      "ready": true, "isHost": true }
  ]
}
```
- REST kèm theo: `GET /api/games/caro/rooms` (danh sách phòng công khai đang mở),
  `GET /api/games/caro/rooms/mine` (phòng của tôi để reconnect),
  `GET /api/games/caro/rooms/:roomId` (chi tiết 1 phòng theo id),
  `GET /api/games/caro/rooms/code/:code` (tra phòng theo mã — preview trước khi vào).
- **Lỗi vào phòng (mã sai…):** mọi handler WS trả lỗi theo envelope
  `{ success: false, error: { code, message } }` qua **ack callback**, đồng thời phát event
  `caro.on('exception', ({ code, message }) => ...)`. Frontend đọc `error.message` để hiện toast
  (vd code sai → `code: "NOT_FOUND"`, message `No room found for code "CR-XXXX"`).
- Khi `caro:room:started`, gọi `caro:join` với `gameId` như trận thường. Lúc kết thúc,
  `caro:end` trả `mode: "WAGER"`, `pot`, và ví được cập nhật qua event `wallet:transaction`
  trên namespace `/ws` (chat).

### 13.6 Thách đấu trực tiếp (lời mời — đối thủ phải đồng ý)
> Thách đấu KHÔNG tạo trận ngay. Người được mời nhận lời mời, **đồng ý** mới vào trận.
> Lời mời tự hết hạn sau ~45s.
```ts
// 1) Người A gửi lời mời tới B
caro.emit('caro:challenge', { opponentId: 'u2', ranked: false }, (ack) => {
  // ack = { challengeId, sent: true, expiresInMs: 45000 }
});

// 2) Người B nhận lời mời -> hiện popup "A mời bạn chơi cờ" với nút Đồng ý / Từ chối
caro.on('caro:challenge-received', ({ challengeId, from, mode, ranked, expiresInMs }) => {
  // from = card người mời {id,username,displayName,avatarUrl,level,rank}
});

// 3a) B đồng ý -> trận được tạo, cả 2 nhận caro:matched
caro.emit('caro:challenge:accept', { challengeId }, (ack) => { /* { gameId } */ });
caro.on('caro:challenge-accepted', ({ challengeId, gameId, byUserId }) => goToGame(gameId)); // A nhận
caro.on('caro:matched', (game) => goToGame(game.id)); // cả 2 nhận

// 3b) B từ chối -> A được báo
caro.emit('caro:challenge:decline', { challengeId }, (ack) => { /* { declined: true } */ });
caro.on('caro:challenge-declined', ({ challengeId, byUserId }) => toast('Lời mời bị từ chối'));
```
- `ranked: false` (mặc định) → trận CASUAL (không RP). `ranked: true` → tính RP.
- Lời mời hết hạn (không bấm gì) → `caro:challenge:accept` trả lỗi "Challenge expired".
- Ai đi trước (X) ngẫu nhiên.

### 13.7 Trong trận
```ts
// Vào room trận để nhận update + cho phép reconnect. Trả về GameView hiện tại.
caro.emit('caro:join', { gameId }, (view /* GameView */) => { renderBoard(view); });

// Đánh 1 nước. Server validate (đúng lượt, ô trống, trong biên). Trả về GameView mới.
caro.emit('caro:move', { gameId, row, col }, (view) => {
  // nếu sai lượt/sai ô -> server trả lỗi qua event 'exception' (xem 13.8)
});

// Đầu hàng -> đối thủ thắng.
caro.emit('caro:resign', { gameId }, (view) => {});

// Rời room (không tính thua nếu trận đã xong; nếu đang chơi mà mất kết nối sẽ tính grace 30s).
caro.emit('caro:leave', { gameId }, (ack) => {});
```

### 13.8 Sự kiện realtime trong room `caro:{gameId}`
```ts
// Có nước đi mới (cả nước của đối thủ và của mình)
caro.on('caro:move', ({ gameId, by, mark, row, col, nextTurn }) => {
  // by = userId người vừa đi, mark = 1|2, nextTurn = 1|2
});

// Trận kết thúc (thắng/thua/hòa/timeout/disconnect/resign) -> payload là GameView đầy đủ
caro.on('caro:end', (game /* GameView */) => {
  // game.winner, game.endReason, game.winningLine, game.rpChange
});

// Đối thủ rớt mạng -> đang đếm ngược forfeit
caro.on('caro:opponent-disconnected', ({ gameId, userId, graceMs }) => {});
// Đối thủ quay lại kịp
caro.on('caro:opponent-reconnected', ({ gameId, userId }) => {});
```

### 13.9 Lỗi & đồng hồ
- Nước đi không hợp lệ (sai lượt, ô đã có, ngoài biên, trận không ACTIVE) → backend
  emit event `exception` với `{ message }` trên `caro` socket (NestJS WsException).
  Frontend nên lắng nghe để hiện toast và không cập nhật lạc quan.
- **Đồng hồ 30s/nước** (`turnSeconds`): hết giờ người đang tới lượt **thua** (endReason `TIMEOUT`).
  Frontend nên tự đếm ngược 30s mỗi khi `turn` đổi; server là nguồn chân lý.
- **Mất kết nối**: rời room/đứt socket khi đang chơi → có **30s** để quay lại
  (`caro:join` lại). Quá hạn → thua (endReason `DISCONNECT`).

### 13.10 RP & Rank
- Chỉ trận `mode: "RANKED"` mới đổi RP. ELO K=32: thắng người mạnh hơn được nhiều RP hơn,
  thắng người yếu hơn được ít hơn. Người thắng luôn +≥1, người thua luôn −≥1, hòa gần 0.
- Trận `mode: "WAGER"` KHÔNG đổi RP — chỉ chuyển xu (người thắng lấy pot, hòa hoàn cược).
- RP cập nhật vào `rankPoints` của user → kéo theo `rank:changed/promoted/demoted`
  (xem mục 12) phát trên namespace **`/ws`** (chat). Frontend nên cập nhật badge rank
  khi nhận các event đó, đồng thời đọc `rpChange` trong `caro:end` để hiện "+16 RP".

### 13.11 Luồng tích hợp gợi ý
1. Mở `caro` socket khi vào khu vực game. Gọi `caro:lobby:join` để thấy số người đang tìm.
2. Bấm "Tìm trận nhanh" → `caro:queue:join`. Hiện spinner + `searching`.
3. Nhận `caro:matched` → vào màn cờ, gọi `caro:join` để lấy `GameView` + nhận update.
4. (Cược xu) "Tạo phòng" → `caro:room:create` với `betAmount`; mời bạn vào bằng `code`.
   Tất cả ready → host `caro:room:start` → nhận `caro:room:started` → `caro:join`.
5. Vẽ bàn 15×15 từ `board`; cho phép click ô trống khi `turn` == mark của mình.
6. Click ô → `caro:move`. Đợi `caro:move` broadcast / ack để đồng bộ (tránh optimistic sai lượt).
7. Nhận `caro:end` → hiện kết quả + `winningLine` tô sáng + `rpChange`/`pot`.
8. "Chơi lại" → quay về bước 2. "Đầu hàng" → `caro:resign`.
9. Khi mở lại app: gọi `GET /api/games/caro/active`; nếu có → `caro:join` để tiếp tục.
   Còn phòng chưa bắt đầu: `GET /api/games/caro/rooms/mine`.

---

## 14. 🃏 Tiến Lên Miền Nam (2–4 người) — ranked RP & cược xu

> Game bài Tiến Lên Miền Nam server-authoritative, 2–4 người. **2 chế độ**:
> RANKED (đổi RP theo thứ hạng về nhất→bét) và WAGER (cược xu, người về **nhất
> lấy toàn bộ pot**). Có thể tạo phòng với mức cược + số người tuỳ ý, hoặc tìm
> trận nhanh ranked theo số người mong muốn. Server giữ bài, validate mọi nước,
> đếm giờ 30s/lượt.

### 14.1 Namespace riêng `/ws-tienlen`
```ts
const tl = io(`${BASE}/ws-tienlen`, { transports: ['websocket'], auth: { token: accessToken } });
```
- Tự join room cá nhân `tienlen-user:{id}` → nhận `tienlen:matched` khi được ghép.
- Vào trận: `tienlen:join` để vào room `tienlen:{gameId}` nhận update + cho phép reconnect.

### 14.2 Mã hoá lá bài (số nguyên 0..51)
```
card  = rankIndex * 4 + suitIndex
rankIndex: 0='3' 1='4' ... 10='K' 11='A' 12='2'   (3 nhỏ nhất, 2 lớn nhất)
suitIndex: 0=♠Bích 1=♣Chuồn 2=♦Rô 3=♥Cơ          (Bích<Chuồn<Rô<Cơ)
```
- So sánh sức mạnh = so sánh số nguyên. Lá nhỏ nhất = `0` (3♠), lớn nhất = `51` (2♥).
- Ví dụ: `cardLabel` "3♠"=0, "4♠"=4, "K♥"=43, "2♥"=51.
- Bộ hợp lệ: **đơn, đôi, ba lá, tứ quý** (4 lá), **sảnh** (≥3 lá liên tiếp, không có 2),
  **đôi thông** (≥3 đôi liên tiếp). Chặt: **3 đôi thông chặt 1 con 2**;
  **tứ quý chặt 2 và chặt 3 đôi thông**; **4 đôi thông chặt 2 con 2 / tứ quý**.

### 14.3 REST
```
GET /api/games/tienlen/rooms              [auth]  danh sách phòng công khai đang mở
GET /api/games/tienlen/rooms/mine         [auth]  phòng của tôi (reconnect lobby)
GET /api/games/tienlen/rooms/:roomId      [auth]  chi tiết 1 phòng theo id
GET /api/games/tienlen/rooms/code/:code   [auth]  tra phòng theo mã (preview trước khi vào)
GET /api/games/tienlen/active             [auth]  trận đang chơi của tôi (reconnect), null nếu không
GET /api/games/tienlen/history?limit=20   [auth]  lịch sử trận đã xong
GET /api/games/tienlen/:gameId            [auth]  trạng thái 1 trận (bài người khác bị ẩn)
```
> **Lỗi qua WebSocket** (mã phòng sai, sai lượt, bộ bài không hợp lệ…) đều trả về
> envelope `{ success: false, error: { code, message } }` qua **ack callback** của lệnh
> emit, đồng thời phát event `tl.on('exception', ({ code, message }) => ...)`. Frontend
> hiển thị `error.message`. KHÔNG còn ném lỗi thô gây log ERROR ở server.

### 14.4 GameView (bài của người khác bị ẩn)
```jsonc
{
  "id": "...", "mode": "RANKED",        // RANKED | WAGER | CASUAL
  "betAmount": 0, "pot": 0, "roomId": null,
  "status": "ACTIVE",                   // ACTIVE | FINISHED | ABORTED
  "turn": 2,                            // seat đang tới lượt
  "turnSeconds": 30,
  "openingCard": 0,                     // lá thấp nhất được chia — người giữ nó ĐI TRƯỚC (chỉ để biết ai lead; KHÔNG bắt buộc phải đánh lá này)
  "currentCombo": [12, 13],             // bộ đang trên bàn (mảng card) — [] = được tự do ra
  "currentComboType": "PAIR",           // SINGLE|PAIR|TRIPLE|STRAIGHT|PAIR_STRAIGHT|FOUR|null
  "leadSeat": 1,                        // seat đang "cầm cái" ván hiện tại
  "finishOrder": [],                    // seat về đích lần lượt (nhất trước)
  "rpChange": null,                     // {userId: delta} khi RANKED kết thúc
  "coinChange": null,                   // {userId: delta} khi WAGER kết thúc
  "players": [
    { "seat": 0, "userId": "u1", "user": {id,username,displayName,avatarUrl,level,rank,levelStyle},
      "handCount": 13, "passed": false, "connected": true, "place": null,
      "hand": [0,5,12,...] }            // 👈 CHỈ có ở chính mình; người khác KHÔNG có field hand
  ],
  "myHand": [0,5,12,...]                // bài của chính người gọi (tiện dùng)
}
```
- `place`: thứ hạng về đích (1=nhất...), `null` nếu chưa về.
- Người khác chỉ thấy `handCount` (số lá còn lại), không thấy `hand`.

### 14.5 Tìm trận nhanh (ranked) + đếm người đang tìm theo số người
```ts
// (Tuỳ chọn) vào sảnh để nhận số người đang tìm trận realtime
tl.emit('tienlen:lobby:join', {}, ({ searching, players }) => {});  // searching = { "2": n, "3": n, "4": n }
tl.emit('tienlen:lobby:leave', {}, () => {});
tl.emit('tienlen:queue:count', {}, ({ searching, players }) => {});

// Số người đang tìm thay đổi (theo từng cỡ bàn) -> phát tới sảnh + người đang xếp hàng
tl.on('tienlen:queue:count', ({ searching, players }) => updateSearching(searching, players));

// Xếp hàng cho bàn `size` người (2|3|4). Khi đủ `size` người -> tạo trận.
tl.emit('tienlen:queue:join', { size: 4 }, (ack) => {
  // { queued: true, size, searching, players }  hoặc  { matched: true, gameId }
});
tl.emit('tienlen:queue:leave', {}, (ack) => { /* { left, searching } */ });

// Khi ghép đủ người, TẤT CẢ nhận:
tl.on('tienlen:matched', (game /* GameView, kèm myHand */) => goToGame(game.id));
```
- **`players`** = danh sách người đang chờ theo từng cỡ bàn, kèm **rank** để hiển thị:
```jsonc
{
  "2": [ { "userId": "u1", "user": { id, username, displayName, avatarUrl, level, levelStyle, rank } } ],
  "3": [], "4": [ ... ]
}
```

### 14.6 Thách đấu trực tiếp (lời mời — đối thủ phải đồng ý) — 1v1
> Giống Caro: gửi lời mời, người được mời **đồng ý** mới vào trận. Hết hạn ~45s.
> Nếu `betAmount > 0`, khi đối thủ đồng ý sẽ **trừ cược cả 2 người** trước khi vào trận
> (thiếu xu thì huỷ + hoàn lại).
```ts
tl.emit('tienlen:challenge', { opponentId: 'u2', ranked: true /* hoặc betAmount: 200 */ },
  (ack) => { /* { challengeId, sent: true, expiresInMs } */ });

tl.on('tienlen:challenge-received', ({ challengeId, from, mode, betAmount, expiresInMs }) => {
  // hiện popup "from mời bạn chơi Tiến Lên" + Đồng ý / Từ chối
});

tl.emit('tienlen:challenge:accept', { challengeId }, (ack) => { /* { gameId } */ });
tl.on('tienlen:challenge-accepted', ({ challengeId, gameId, byUserId }) => goToGame(gameId));
tl.on('tienlen:matched', (game) => goToGame(game.id));

tl.emit('tienlen:challenge:decline', { challengeId }, (ack) => {});
tl.on('tienlen:challenge-declined', ({ challengeId, byUserId }) => toast('Bị từ chối'));
```

### 14.7 Phòng cược xu / tuỳ chỉnh (2–4 người)
```ts
// Tạo phòng. ranked=true -> phòng xếp hạng RP; có betAmount>0 -> cược xu (WAGER).
tl.emit('tienlen:room:create',
  { betAmount: 200, maxPlayers: 4, ranked: false, isPrivate: false, name: 'Bàn vui' },
  (room /* RoomView */) => {});

tl.emit('tienlen:room:join', { roomId } /* hoặc { code: 'TL-1A2B' } */, (room) => {});
tl.emit('tienlen:room:ready', { roomId, ready: true }, (room) => {});
tl.emit('tienlen:room:start', { roomId }, (ack) => { /* { gameId } */ });
tl.emit('tienlen:room:leave', { roomId }, (ack) => { /* { left, cancelled } */ });

// Sự kiện trong room `tienlen-room:{roomId}`
tl.on('tienlen:room:updated', (room) => renderLobby(room));
tl.on('tienlen:room:started', ({ roomId, gameId }) => goToGame(gameId));
tl.on('tienlen:room:closed',  ({ roomId, reason }) => leaveLobby());
```
- `RoomView` giống Caro (mục 13.5) nhưng `game: "TIENLEN"`, `maxPlayers` 2–4, code dạng `TL-XXXX`.
- WAGER: tạo/join bị **trừ cược** vào pot; host bắt đầu khi đủ người + mọi người ready.
- Host rời khi đang chờ → phòng huỷ, hoàn cược tất cả.

### 14.8 Trong trận
```ts
tl.emit('tienlen:join', { gameId }, (view /* GameView kèm myHand */) => renderTable(view));

// Đánh 1 bộ bài (mảng card). Người cầm cái (lá thấp nhất) ĐI TRƯỚC nhưng được
// đánh BẤT KỲ bộ hợp lệ nào — KHÔNG bắt buộc phải đánh lá thấp nhất.
tl.emit('tienlen:play', { gameId, cards: [/* bộ hợp lệ bất kỳ */] }, (view) => {
  // sai bộ / không chặt được / sai lượt -> event 'exception'
});

// Bỏ lượt (chỉ khi đang có bộ trên bàn; không được bỏ khi mình được tự do ra)
tl.emit('tienlen:pass', { gameId }, (view) => {});

// Đầu hàng (bị xếp hạng bét trong số người còn lại)
tl.emit('tienlen:resign', { gameId }, (view) => {});

tl.emit('tienlen:leave', { gameId }, () => {});
```

### 14.9 Sự kiện realtime trong room `tienlen:{gameId}`
```ts
tl.on('tienlen:play', ({ gameId, seat, userId, cards, comboType, handCount, nextTurn, currentCombo, chop }) => {
  // chop != null khi nước này là "chặt heo":
  //   { chopper, victim, heoCount, black, red, units, heoCards }
});
tl.on('tienlen:pass', ({ gameId, seat, userId, nextTurn, trickReset }) => {});
tl.on('tienlen:resigned', ({ gameId, userId, seat, nextTurn }) => {});

// Chặt heo bị phạt (phát ngay sau nước chặt). WAGER -> coins; RANKED -> rp.
tl.on('tienlen:chop', ({ gameId, chopper, victim, black, red, heoCount, coins, blackPrice, redPrice, rp, insufficient }) => {
  // black/red = số heo đen (♠♣) / đỏ (♦♥) bị chặt
  // WAGER: coins = tổng xu victim trả chopper; blackPrice/redPrice = giá 1 heo đen/đỏ
  //        insufficient: true nếu victim không đủ xu (không trừ được)
  // RANKED: rp = RP victim mất / chopper được
});

tl.on('tienlen:end', (game /* GameView: finishOrder, rpChange/coinChange, chops, instantWin */) => showResult(game));
tl.on('tienlen:player-disconnected', ({ gameId, userId }) => {});
tl.on('tienlen:player-reconnected', ({ gameId, userId }) => {});
```
- `trickReset: true` nghĩa là vòng bài kết thúc (mọi người đã bỏ lượt) → người cầm cái được ra bộ mới (`currentCombo` rỗng).
- Lỗi nước đi đều phát qua event `exception` `{ message }`.

### 14.10 Tới trắng + chặt heo
- **Tới trắng (instant win):** nếu khi chia bài ai đó có bài đặc biệt, ván **kết thúc ngay**
  khi vừa `tienlen:matched`, kèm `tienlen:end` có `instantWin: { userId, kind }`:
  - `TU_QUY_HEO` (tứ quý 2), `SANH_RONG` (sảnh rồng 3→A), `SAU_DOI` (6 đôi), `NAM_DOI_THONG` (5 đôi thông).
  - RANKED: người tới trắng được RP hạng nhất + thưởng thêm (config `TIENLEN_INSTANT_WIN_RP`).
  - WAGER: người tới trắng lấy toàn bộ pot.
- **Chặt heo (chop):** khi dùng bom (tứ quý / 3+ đôi thông) chặt con 2 (heo) của người khác.
  Heo **đen** (♠/♣) và heo **đỏ** (♦/♥) bị phạt KHÁC NHAU — **heo đỏ đắt gấp đôi heo đen**:
  - **WAGER**: tiền phạt **theo tỉ lệ mức cược**. Giá 1 heo đen = `round(betAmount × TIENLEN_CHOP_HEO_BET_RATIO)`,
    heo đỏ = gấp đôi. Tổng = `blackPrice × units` với `units = (#đen) + 2×(#đỏ)`. Nạn nhân trả chopper số xu này
    (event `tienlen:chop` có `coins`, `blackPrice`, `redPrice`; `insufficient: true` nếu nạn nhân không đủ xu).
    Ví dụ bet=200, ratio=0.5 → heo đen 100 xu, heo đỏ 200 xu.
  - **RANKED**: nạn nhân **bị trừ** `TIENLEN_CHOP_HEO_RP × units` RP, chopper **được cộng** bấy nhiêu
    (event `tienlen:chop` có `rp`). Kéo theo `rank:changed/promoted/demoted` trên `/ws`.
  - Chặt 1 con 2 = 1 heo; chặt đôi 2 = 2 heo. `game.chops[]` trong GameView lưu lịch sử chặt (kèm `black`/`red`).

### 14.11 Đồng hồ, mất kết nối, phần thưởng
- **30s/lượt** (`turnSeconds`): hết giờ server tự xử — nếu được tự do ra thì tự đánh lá thấp nhất,
  nếu đang có bộ trên bàn thì **tự bỏ lượt**. Frontend tự đếm ngược theo `turn`.
- **Mất kết nối**: người mất kết nối có **30s** để quay lại (`GET /api/games/tienlen/active`
  → `tienlen:join`). Nếu tới lượt họ mà đang vắng, server **bỏ lượt giúp** (không tự đánh bài
  để tránh thắng hộ). Quá 30s không quay lại → **bị xử thua** (xếp hạng bét, phát
  `tienlen:resigned` với `reason: "DISCONNECT"`), người ở lại thắng.
- **RANKED**: RP chia theo thứ hạng — về nhất +nhiều nhất, về bét −nhiều nhất
  (đọc `rpChange` trong `tienlen:end`), cộng/trừ thêm theo chặt heo. Kéo theo `rank:*` trên `/ws`.
- **WAGER**: người về **nhất lấy toàn bộ pot** + nhận xu chặt heo; ví cập nhật qua `wallet:transaction` trên `/ws`.
  Đọc `coinChange` trong `tienlen:end` để hiện +/- xu.

### 14.12 Luồng tích hợp gợi ý
1. Mở `tl` socket + `tienlen:lobby:join` để thấy số người đang tìm (theo cỡ bàn 2/3/4) + rank của họ.
2. "Tìm trận nhanh" → `tienlen:queue:join { size }`. Nhận `tienlen:matched` → `tienlen:join`.
3. Hoặc "Thách đấu" 1 người → `tienlen:challenge`; đối thủ `accept` → cả 2 `tienlen:matched`.
4. Hoặc "Tạo phòng" → `tienlen:room:create` (đặt `betAmount`/`maxPlayers`/`ranked`), mời bằng `code`.
   Mọi người ready → host `tienlen:room:start` → `tienlen:room:started` → `tienlen:join`.
5. Vẽ bàn từ `players` (theo `seat`), bài mình từ `myHand`. Tô sáng khi `turn` == seat của mình.
6. Chọn lá → `tienlen:play { cards }`; không đánh được → `tienlen:pass`. Hiện hiệu ứng khi `chop`/`tienlen:chop`.
7. Nhận `tienlen:end` → bảng xếp hạng + `rpChange`/`coinChange` + `instantWin` (nếu tới trắng).


---

## 15. 💣 Bomberman (2–4 người) — realtime, ranked RP & cược xu

> Game đặt bom realtime server-authoritative, 2–4 người. Bàn lưới (nhiều map),
> phá gạch để mở đường + nhặt vật phẩm (BOMB/FLAME/SPEED), người sống sót cuối
> cùng thắng. **Server chạy game-loop ~20Hz** và broadcast snapshot; client chỉ
> gửi INPUT (hướng đi + đặt bom) và VẼ LẠI. Khác Caro/Tiến Lên (turn-based).

### 15.1 Namespace riêng `/ws-bomberman`
```ts
const bm = io(`${BASE}/ws-bomberman`, { transports: ['websocket'], auth: { token: accessToken } });
```
- Tự join `bomberman-user:{id}` → nhận `bomberman:matched`.
- Vào trận: `bomberman:join` để vào room `bomberman:{gameId}` nhận snapshot + reconnect.

### 15.2 REST
```
GET /api/games/bomberman/maps              danh sách map { id, name, cols, rows }
GET /api/games/bomberman/rooms             phòng công khai đang mở
GET /api/games/bomberman/rooms/mine        phòng của tôi (reconnect)
GET /api/games/bomberman/rooms/code/:code  tra phòng theo mã
GET /api/games/bomberman/rooms/:roomId     chi tiết phòng
GET /api/games/bomberman/active            trận đang chơi của tôi (reconnect), null nếu không
GET /api/games/bomberman/history?limit=20  lịch sử trận đã xong
```

### 15.3 "matched" view (bản đồ tĩnh + người chơi)
```jsonc
{
  "id": "...", "mapId": "classic", "cols": 13, "rows": 11,
  "grid": [0,1,2,...],          // flat rows*cols: 0 trống, 1 tường cứng, 2 gạch phá được
  "mode": "RANKED", "betAmount": 0, "pot": 0, "roomId": null,
  "status": "ACTIVE", "tickHz": 20, "roundLimitMs": 180000, "startedAt": 0,
  "players": [
    { "seat": 0, "userId": "u1", "user": {id,username,displayName,avatarUrl,level,rank,levelStyle},
      "spawn": { "col": 1, "row": 1 } }
  ],
  "snapshot": { ... }            // trạng thái động hiện tại (xem 15.5), kèm khi join để render ngay
}
```
- `index = row*cols + col`. Toạ độ người chơi là **liên tục** (float) theo đơn vị ô.

### 15.4 Tìm trận / phòng / thách đấu (giống Tiến Lên)
```ts
// tìm nhanh theo cỡ bàn (2|3|4), ranked
bm.emit('bomberman:lobby:join', {}, ({ searching, players }) => {}); // searching={ "2":n,"3":n,"4":n }
bm.on('bomberman:queue:count', ({ searching, players }) => {});
bm.emit('bomberman:queue:join', { size: 4 }, (ack) => { /* {queued,...} | {matched,gameId} */ });
bm.emit('bomberman:queue:leave', {}, () => {});
bm.on('bomberman:matched', (view) => goToGame(view.id));

// thách đấu 1v1 (lời mời, phải đồng ý) — giống caro
bm.emit('bomberman:challenge', { opponentId, ranked: true }, ({ challengeId }) => {});
bm.on('bomberman:challenge-received', ({ challengeId, from, ranked, expiresInMs }) => {});
bm.emit('bomberman:challenge:accept',  { challengeId }, ({ gameId }) => {});
bm.emit('bomberman:challenge:decline', { challengeId }, () => {});
bm.on('bomberman:challenge-accepted', ({ gameId }) => {});
bm.on('bomberman:challenge-declined', () => {});

// phòng (chọn map + số người + cược)
bm.emit('bomberman:room:create', { betAmount: 0, maxPlayers: 4, mapId: 'arena', isPrivate: false, name }, (room) => {});
bm.emit('bomberman:room:join',  { roomId } /* hoặc { code } */, (room) => {});
bm.emit('bomberman:room:ready', { roomId, ready: true }, (room) => {});
bm.emit('bomberman:room:start', { roomId }, ({ gameId }) => {});
bm.emit('bomberman:room:leave', { roomId }, ({ cancelled }) => {});
bm.on('bomberman:room:updated', (room) => {});   // RoomView như mục 13.5, game:"BOMBERMAN", code "BM-XXXX"
bm.on('bomberman:room:started', ({ gameId }) => {});
bm.on('bomberman:room:closed',  ({ reason }) => {});
```

### 15.5 Trong trận
```ts
bm.emit('bomberman:join', { gameId }, (view) => renderMap(view)); // matched view + snapshot
bm.emit('bomberman:input', { gameId, dx, dy });  // dx/dy ∈ -1|0|1 (gửi khi ĐỔI hướng, fire-and-forget)
bm.emit('bomberman:bomb',  { gameId });           // đặt bom tại ô đang đứng
bm.emit('bomberman:leave', { gameId });           // rời = tự sát để ván kết thúc

// snapshot mỗi tick (~20/giây) — render nội suy để mượt
bm.on('bomberman:state', (s) => {
  // s.players:[{seat,userId,x,y,alive,dx,dy,bombs,flame}], s.bombs:[{col,row,ownerId,fuseMs}],
  // s.flames:[{col,row}], s.powerups:[{col,row,type:'BOMB'|'FLAME'|'SPEED'}]
});
bm.on('bomberman:bomb',   ({ col, row, ownerId, fuseMs }) => {});      // đặt bom
bm.on('bomberman:explode',({ flames, destroyed }) => {});             // destroyed:[{col,row,drop}]
bm.on('bomberman:pickup', ({ seat, type }) => {});
bm.on('bomberman:death',  ({ seat }) => {});
bm.on('bomberman:end', (e) => {
  // e.winner, e.placements{userId:rank}, e.ranking[{userId,user,place}], e.rpChange, e.coinChange, e.pot
});
```

### 15.6 Luật & phần thưởng
- Bom nổ sau ~2.2s thành lửa hình chữ thập (bán kính = chỉ số FLAME của người đặt),
  phá 1 lớp gạch, nổ dây chuyền bom khác, giết người đứng trong lửa.
- Vật phẩm rơi từ gạch: **BOMB** (+1 bom cùng lúc), **FLAME** (+1 tầm nổ), **SPEED** (+ tốc độ).
- Hết người (≤1 sống) hoặc quá 3 phút → kết thúc. Last-survivor = nhất.
- **RANKED**: RP chia theo thứ hạng (nhất +nhiều nhất, bét −nhiều nhất) — đọc `rpChange`.
- **WAGER**: nhất lấy toàn bộ pot — đọc `coinChange`; ví cập nhật qua `wallet:transaction` trên `/ws`.
- **Reconnect**: `GET /api/games/bomberman/active` → `bomberman:join`. Rời/ngắt kết nối khi đang chơi = chết.

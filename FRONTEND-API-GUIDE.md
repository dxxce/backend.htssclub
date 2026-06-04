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

### 13.4 Ghép trận (matchmaking xếp hạng)
```ts
// Vào hàng chờ ghép trận ranked
caro.emit('caro:queue:join', {}, (ack) => {
  // ack = { queued: true, queueSize } nếu chưa có đối thủ
  // hoặc { matched: true, gameId } nếu được ghép ngay với người đang chờ
});

// Rời hàng chờ
caro.emit('caro:queue:leave', {}, (ack) => { /* { left: true } */ });

// Khi backend ghép được cặp, CẢ HAI người nhận:
caro.on('caro:matched', (game /* GameView */) => {
  // -> điều hướng vào màn chơi, rồi gọi caro:join để vào room nhận update
});
```
- Ghép theo RP gần nhất (Redis sorted-set, hoạt động đa-instance).
- Ai đi trước (X) là ngẫu nhiên.

### 13.5 Thách đấu trực tiếp (mời 1 người chơi)
```ts
caro.emit('caro:challenge', { opponentId: 'u2', ranked: false }, (ack) => {
  // ack = { gameId }
});
```
- `ranked` mặc định `false` cho thách đấu (không ăn RP). Đặt `true` nếu muốn tính RP.
- Đối thủ nhận `caro:matched` ở room cá nhân của họ.

### 13.6 Trong trận
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

### 13.7 Sự kiện realtime trong room `caro:{gameId}`
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

### 13.8 Lỗi & đồng hồ
- Nước đi không hợp lệ (sai lượt, ô đã có, ngoài biên, trận không ACTIVE) → backend
  emit event `exception` với `{ message }` trên `caro` socket (NestJS WsException).
  Frontend nên lắng nghe để hiện toast và không cập nhật lạc quan.
- **Đồng hồ 30s/nước** (`turnSeconds`): hết giờ người đang tới lượt **thua** (endReason `TIMEOUT`).
  Frontend nên tự đếm ngược 30s mỗi khi `turn` đổi; server là nguồn chân lý.
- **Mất kết nối**: rời room/đứt socket khi đang chơi → có **30s** để quay lại
  (`caro:join` lại). Quá hạn → thua (endReason `DISCONNECT`).

### 13.9 RP & Rank
- Chỉ trận `ranked: true` mới đổi RP. ELO K=32: thắng người mạnh hơn được nhiều RP hơn,
  thắng người yếu hơn được ít hơn. Người thắng luôn +≥1, người thua luôn −≥1, hòa gần 0.
- RP cập nhật vào `rankPoints` của user → kéo theo `rank:changed/promoted/demoted`
  (xem mục 12) phát trên namespace **`/ws`** (chat). Frontend nên cập nhật badge rank
  khi nhận các event đó, đồng thời đọc `rpChange` trong `caro:end` để hiện "+16 RP".

### 13.10 Luồng tích hợp gợi ý
1. Mở `caro` socket khi vào khu vực game.
2. Bấm "Tìm trận" → `caro:queue:join`. Hiện spinner + `queueSize`.
3. Nhận `caro:matched` → vào màn cờ, gọi `caro:join` để lấy `GameView` + nhận update.
4. Vẽ bàn 15×15 từ `board`; cho phép click ô trống khi `turn` == mark của mình.
5. Click ô → `caro:move`. Đợi `caro:move` broadcast / ack để đồng bộ (tránh optimistic sai lượt).
6. Nhận `caro:end` → hiện kết quả + `winningLine` tô sáng + `rpChange`.
7. "Chơi lại" → quay về bước 2. "Đầu hàng" → `caro:resign`.
8. Khi mở lại app: gọi `GET /api/games/caro/active`; nếu có → `caro:join` để tiếp tục.

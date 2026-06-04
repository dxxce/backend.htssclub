# 🎯 Lệnh cho Agent Frontend — Đồng bộ Realtime (Chat, Voice, Profile, Server)

> **Mục tiêu:** Cập nhật frontend để xử lý các sự kiện realtime mới từ backend.
> Backend đã triển khai và test xong. KHÔNG đổi tên event/payload dưới đây.
> Có **2 namespace Socket.IO**: `/ws` (chat + server/profile/voice-presence)
> và `/ws-voice` (WebRTC signaling trong phòng thoại).

---

## 0. Kết nối Socket

```ts
import { io } from 'socket.io-client';

const BASE = 'http://<host>:<port>';        // ví dụ http://localhost:3366
const accessToken = '<JWT access token>';

// Namespace chat (dùng cho chat, presence, server/profile sync, voice occupancy)
const chat = io(`${BASE}/ws`, { transports: ['websocket'], auth: { token: accessToken } });

// Namespace voice (chỉ mở khi user BẤM vào kênh thoại để nói)
const voice = io(`${BASE}/ws-voice`, { transports: ['websocket'], auth: { token: accessToken } });
```

- `chat` socket khi connect sẽ TỰ join room cá nhân `user:{id}` và mọi `server:{id}` user là thành viên. Frontend KHÔNG cần emit gì để nhận các sự kiện server-wide.
- `voice` socket chỉ kết nối khi user thực sự tham gia nói chuyện trong 1 kênh thoại.

---

## 1. 🔊 Voice: hiển thị người trong phòng cho TẤT CẢ member (kể cả người không vào)

**Vấn đề cũ:** chỉ người đã vào phòng thoại mới thấy ai đang ở trong đó. Người
đang xem server (chưa bấm vào kênh thoại) không thấy gì và không có realtime.

### 1a. Hiển thị lúc tải danh sách kênh
`GET /api/servers/:serverId/channels` giờ trả về, với mỗi kênh `type: "VOICE"`,
thêm field `voiceMembers`:

```jsonc
{
  "id": "channelId",
  "name": "oh my pc",
  "type": "VOICE",
  "voiceMembers": [
    {
      "userId": "u1",
      "user": { "id": "u1", "username": "dcgxxie", "displayName": "dcgxxie", "avatarUrl": "..." },
      "muted": false, "deafened": false, "speaking": false
    }
  ]
}
```
→ Render danh sách avatar/tên dưới mỗi kênh thoại ngay khi load sidebar.

### 1b. Realtime trên `chat` socket (room server, ai cũng nhận)
```ts
// Có người vào kênh thoại bất kỳ trong server
chat.on('voice:channel-joined', ({ serverId, channelId, member }) => {
  // member = { userId, user:{id,username,displayName,avatarUrl}, muted, deafened, speaking, streaming }
  // -> thêm member vào danh sách dưới kênh `channelId` trong sidebar
});

// Có người rời kênh thoại
chat.on('voice:channel-left', ({ serverId, channelId, userId }) => {
  // -> gỡ userId khỏi danh sách dưới kênh `channelId`
});

// Thành viên bật/tắt mic, tai nghe, hoặc đang stream (ai cũng nhận, kể cả
// người KHÔNG ở trong phòng) -> cập nhật icon ở sidebar
chat.on('voice:channel-state', ({ serverId, channelId, userId, muted, deafened, streaming }) => {
  // -> cập nhật cờ muted/deafened/streaming của `userId` dưới kênh `channelId`
});

// Có người bắt đầu / dừng stream (badge "🔴 Live")
chat.on('stream:started', ({ serverId, channelId, userId, user, source }) => {
  // source: 'screen' | 'camera' -> hiện badge Live + nút "Xem"
});
chat.on('stream:stopped', ({ serverId, channelId, userId }) => { /* gỡ badge Live */ });
```

> `voice:channel-state` KHÔNG gửi `speaking` (tránh spam khi đang nói). Để hiện
> hiệu ứng "đang nói" cho người ở trong phòng, dùng `voice:state-changed` ở mục 2.

> Đây là sửa lỗi trong ảnh: trước đây bảng bên phải không hiện `dcgxxie`.
> Sau khi xử lý 1a + 1b, mọi member đều thấy occupancy realtime.

---

## 2. 🎙️ Voice + Stream qua LiveKit (`/ws-voice`) — KHÔNG còn mesh P2P

> **THAY ĐỔI LỚN:** Toàn bộ âm thanh **và** video (chia sẻ màn hình / camera)
> giờ đi qua **LiveKit (SFU)**. KHÔNG còn signaling mesh P2P
> (`voice:offer/answer/ice` đã bị gỡ bỏ). Client KHÔNG tự tạo `RTCPeerConnection`
> nữa — dùng **LiveKit Client SDK** (`livekit-client`) để kết nối phòng.

### Cài đặt
```bash
npm install livekit-client
```

### Luồng tham gia phòng thoại
```ts
import { Room } from 'livekit-client';

// 1) Báo backend mình vào phòng -> nhận LiveKit credentials qua ack.
voice.emit('voice:join', { channelId }, async (resp) => {
  // resp = { channelId, livekit: { url, token, room, identity }, peers: VoiceMember[] }
  // peers = roster hiện tại (để render danh sách thành viên ngay)

  // 2) Kết nối phòng LiveKit bằng SDK.
  const room = new Room();
  await room.connect(resp.livekit.url, resp.livekit.token);

  // 3) Bật mic (audio track).
  await room.localParticipant.setMicrophoneEnabled(true);

  // 4) Nghe audio/video của người khác.
  room.on('trackSubscribed', (track, pub, participant) => {
    // participant.identity == userId của app -> map về VoiceMember
    track.attach(); // audio tự phát; video -> gắn vào <video>
  });
});
```

### Emit (client → server) — chỉ control plane, KHÔNG còn SDP/ICE
```ts
voice.emit('voice:join',  { channelId });          // ack trả { livekit, peers }
voice.emit('voice:leave', { channelId });
voice.emit('voice:token', { channelId });          // xin lại token nếu hết hạn
voice.emit('voice:state', { muted?, deafened?, speaking? });
voice.emit('stream:start', { source: 'screen' | 'camera' });  // báo bắt đầu stream
voice.emit('stream:stop',  {});                    // báo dừng stream
```

### Listen (server → client)
```ts
// Roster ban đầu khi vừa join (chỉ mình nhận)
voice.on('voice:peers', ({ channelId, peers }) => { /* render danh sách */ });

// Có người mới vào / rời phòng (cập nhật danh sách thành viên)
voice.on('voice:user-joined', ({ channelId, user }) => { /* user: VoiceMember */ });
voice.on('voice:user-left',   ({ channelId, userId }) => {});

// Mic/loa/speaking của thành viên (bỏ qua nếu là chính mình)
voice.on('voice:state-changed', ({ userId, muted, deafened, speaking, streaming }) => {});

// Stream bắt đầu / dừng (cho người ĐANG trong phòng)
voice.on('stream:started', ({ channelId, userId, user, source }) => {
  // -> hiện "đang xem" / tự subscribe video track của `userId` qua LiveKit
});
voice.on('stream:stopped', ({ channelId, userId }) => {});
```

`VoiceMember = { userId, user: { id, username, displayName, avatarUrl }, muted, deafened, speaking, streaming }`

### Chia sẻ màn hình / camera (streaming)
```ts
// Bắt đầu stream: publish video track LÊN LiveKit + báo backend.
await room.localParticipant.setScreenShareEnabled(true); // hoặc setCameraEnabled(true)
voice.emit('stream:start', { source: 'screen' });

// Dừng:
await room.localParticipant.setScreenShareEnabled(false);
voice.emit('stream:stop', {});
```

**Người xem:** khi nhận `stream:started`, LiveKit tự đẩy `trackSubscribed` cho
video track của streamer (lọc theo `participant.identity === userId` và
`track.source === 'screen_share'`/`'camera'`) → gắn vào thẻ `<video>`.

> Tóm tắt vai trò: backend lo **token + ai-đang-ở-đâu + ai-đang-stream** (control
> plane). LiveKit lo **truyền media** (audio + video). Client chỉ nói chuyện với
> 2 nơi: `/ws-voice` (control) và LiveKit room (media).

---

## 3. 👤 Đồng bộ avatar/tên USER khi đổi hồ sơ

Khi 1 user đổi `displayName`/`avatarUrl` (qua `PATCH /api/users/me`), backend phát
`user:updated` tới mọi server họ tham gia.

```ts
chat.on('user:updated', ({ serverId, user }) => {
  // user = { id, username, displayName, avatarUrl }
  // -> cập nhật tên/avatar của user này ở MỌI nơi đang hiển thị:
  //    danh sách thành viên server, tin nhắn cũ, danh sách voice, v.v.
});
```
- Có thể nhận sự kiện này nhiều lần (1 lần cho mỗi server chung) — xử lý idempotent.
- Bản thân người đổi cũng nhận `user:updated` ở room cá nhân (payload không có `serverId`).

**Việc cần làm ở frontend:** Lưu profile user theo `userId` trong 1 store tập trung
(vd Map/Pinia/Redux), các component render từ store đó. Khi nhận `user:updated`,
cập nhật store → mọi chỗ tự re-render. Tránh "đóng băng" tên/avatar vào từng tin nhắn.

---

## 4. 🏠 Đồng bộ tên/icon SERVER khi admin chỉnh sửa

Khi admin đổi `name`/`iconUrl` (qua `PATCH /api/servers/:id`), backend phát
`server:updated` tới room server.

```ts
chat.on('server:updated', (server) => {
  // server = { id, name, iconUrl, ownerId, isDefault, ... }
  // -> cập nhật tên + icon server trên sidebar / header
});
```

---

## 5. 📡 Các sự kiện server/channel khác (đã có, nên xử lý cho UI mượt)

```ts
// Kênh
chat.on('channel:created',   (channel) => { /* thêm vào danh sách kênh */ });
chat.on('channel:updated',   (channel) => { /* đổi tên/topic/vị trí */ });
chat.on('channel:deleted',   ({ serverId, channelId }) => { /* xóa khỏi danh sách */ });
chat.on('channel:reordered', ({ serverId, channels }) => { /* sắp xếp lại */ });

// Thành viên server
chat.on('server:member-joined',  ({ serverId, userId, member }) => {
  // member = { userId, role, nickname, joinedAt, user:{id,username,displayName,avatarUrl} }
  // -> thêm member vào danh sách thành viên server NGAY (không cần fetch lại)
  // Phát cả khi: join bằng invite, VÀ khi user mới đăng ký auto-join server mặc định.
});
chat.on('server:member-left',    ({ serverId, userId }) => {});
chat.on('server:member-updated', ({ serverId, userId, role?, nickname? }) => {});
chat.on('server:member-banned',  ({ serverId, userId, reason }) => {});
chat.on('server:you-were-banned',({ serverId, reason }) => { /* rời server khỏi UI */ });
chat.on('server:deleted',        ({ serverId }) => { /* server bị xóa -> gỡ khỏi UI */ });
chat.on('server:ownership-transferred', ({ serverId, from, to }) => {});
chat.on('server:announcement',   ({ serverId, message, byUserId, at }) => { /* toast/thông báo */ });

// Kênh thoại bị xóa khi đang ở trong (trên voice socket)
voice.on('voice:channel-closed', ({ channelId }) => { /* rời phòng, dọn UI */ });
```

---

## 6. 💬 Chat realtime (đã có — nhắc lại để đầy đủ, trên `chat` socket)

```ts
chat.emit('channel:join',  { channelId });     // vào room kênh text để nhận tin
chat.emit('channel:leave', { channelId });
chat.emit('message:send',  { channelId, content?, attachments?, replyToId? });
chat.emit('typing:start',  { channelId });
chat.emit('typing:stop',   { channelId });
chat.emit('presence:update', { status });      // ONLINE | IDLE | DND | OFFLINE

chat.on('message:new',     (message) => {});
chat.on('message:updated', (message) => {});
chat.on('message:deleted', ({ messageId, channelId }) => {});
chat.on('typing',          ({ channelId, userId, isTyping }) => {});
chat.on('presence:changed',({ userId, presence }) => {});
chat.on('notification:new',(notification) => {});
```

### Đính kèm tin nhắn (ảnh / video / audio / file)
1. Upload trước: `POST /api/uploads/attachment` (multipart `file`) → trả
   `{ url, type, name, size, category }` với `category` ∈ `IMAGE|VIDEO|AUDIO|FILE`.
   - Ảnh/audio/file: ≤ 25MB. Video: ≤ 200MB.
2. Gửi tin kèm metadata đó vào `attachments` (tối đa 10). **`content` có thể bỏ trống
   nếu có ít nhất 1 đính kèm** → cho phép gửi tin chỉ-có-tệp.

---

## 7. ✅ Checklist cho agent frontend

- [ ] Tạo **user store** theo `userId` (tên/avatar) và render component từ store.
- [ ] Xử lý `user:updated` → cập nhật store (mục 3).
- [ ] Xử lý `server:updated` → cập nhật tên/icon server (mục 4).
- [ ] Render `voiceMembers` từ danh sách kênh khi load (mục 1a).
- [ ] Xử lý `voice:channel-joined` / `voice:channel-left` trên `chat` socket để cập nhật
      occupancy kênh thoại realtime cho cả người không vào phòng (mục 1b).
- [ ] Xử lý `voice:channel-state` trên `chat` socket để cập nhật icon tắt mic / tắt
      tai nghe của thành viên trong kênh thoại cho cả người không vào phòng (mục 1b).
- [ ] Tham gia phòng thoại qua LiveKit: `voice:join` -> nhận `livekit` token ->
      kết nối bằng `livekit-client` (mục 2). KHÔNG còn mesh/RTCPeerConnection.
- [ ] Chia sẻ màn hình/camera: publish track lên LiveKit + emit `stream:start`/`stream:stop`;
      hiện badge "🔴 Live" từ `stream:started`/`stream:stopped` (mục 1b + 2).
- [ ] Xử lý các sự kiện channel/member (mục 5) cho UI mượt.
- [ ] Cho phép gửi tin chỉ có đính kèm; hỗ trợ video/audio/file (mục 6).

> **Nguyên tắc chung:** Đừng "đóng băng" name/avatar vào từng dòng tin nhắn hay từng
> chỗ hiển thị. Luôn render từ store trung tâm theo `userId`/`serverId`, rồi cập nhật
> store khi nhận sự kiện realtime. Như vậy mọi nơi tự đồng bộ.


---

## 8. 👥 Sự kiện bạn bè (realtime, room cá nhân `user:{id}`)

Phát trên `chat` socket tới đúng người liên quan:
```ts
chat.on('friend:request-received', ({ fromUserId, from, requestId }) => {
  // from = card người gửi {id,username,displayName,avatarUrl}
  // -> hiện lời mời kết bạn mới + nút Chấp nhận/Từ chối (dùng requestId)
});
chat.on('friend:accepted', ({ fromUserId, from, requestId }) => { /* họ đã chấp nhận */ });
chat.on('friend:declined', ({ fromUserId, from, requestId }) => { /* họ đã từ chối */ });
chat.on('friend:removed',  ({ fromUserId, from }) => { /* họ đã hủy kết bạn */ });
```
> Vẫn có `notification:new` (type FRIEND_REQUEST / FRIEND_ACCEPTED) song song để
> lưu vào trung tâm thông báo. Các event `friend:*` dùng để cập nhật UI tức thì.

`user:updated` giờ kèm cả `bio` + `statusMessage`:
```ts
chat.on('user:updated', ({ serverId, user }) => {
  // user = { id, username, displayName, avatarUrl, bio, statusMessage }
});
```

---

## 9. 💰 Sự kiện ví (realtime, room cá nhân)

```ts
chat.on('wallet:transaction', ({ balance, transaction }) => {
  // balance = số dư MỚI sau giao dịch
  // transaction = { id, type, amount, balanceAfter, reason, refId, createdAt }
  //   amount > 0: nhận xu (credit) | amount < 0: trừ xu (debit)
  // -> cập nhật số dư hiển thị + thêm vào lịch sử giao dịch
});
```
Phát cho mọi thay đổi số dư: nạp, tiêu, thưởng/hoàn (admin), và **chuyển xu**
(cả người gửi lẫn người nhận đều nhận event của riêng mình).

---

## 10. 💬 Tin nhắn riêng (DM) — kiểu Discord: TLS + mã hóa at-rest

> **Mô hình:** Giống Discord. Tin nhắn truyền qua **TLS** (wss/https), lưu
> **mã hóa at-rest** (AES-256-GCM) trong DB. **Server ĐỌC ĐƯỢC** nội dung
> (phục vụ tìm kiếm/kiểm duyệt) — KHÔNG phải E2E. Client gửi/nhận **plaintext**;
> backend tự lo mã hóa khi lưu, giải mã khi đọc.

### REST
```
GET    /api/dm/conversations                  inbox + unread
POST   /api/dm/conversations  { toUserId }     mở/lấy hội thoại
GET    /api/dm/conversations/:id/messages?before=&limit=
PATCH  /api/dm/conversations/:id/read
POST   /api/dm/messages  { toUserId, content?, attachments?, replyToId? }
PATCH  /api/dm/messages/:messageId  { content }     (người gửi)
DELETE /api/dm/messages/:messageId                  (người gửi)
```
- `content` có thể RỖNG nếu có ≥1 attachment (gửi tin chỉ-có-tệp).
- attachments: dùng `POST /api/uploads/attachment` trước, gắn metadata vào.
- Message trả về cho client là **plaintext** (đã giải mã sẵn).

### WS (qua `chat`)
```ts
chat.emit('dm:send', { toUserId, content?, attachments?, replyToId? }, (msg) => {});
chat.emit('dm:typing:start', { conversationId });
chat.emit('dm:typing:stop',  { conversationId });
chat.emit('dm:read', { conversationId });

chat.on('dm:new',     ({ conversationId, message, from, unread }) => {});
// from = card người gửi {id,username,displayName,avatarUrl}; unread = số chưa đọc MỚI của mình
chat.on('dm:updated', ({ conversationId, message }) => {});  // sau khi sửa
chat.on('dm:read',    ({ conversationId, byUserId, at }) => {});
chat.on('dm:typing',  ({ conversationId, userId, isTyping }) => {});
chat.on('dm:deleted', ({ conversationId, messageId }) => {});
```
> `unread` trong inbox đếm theo từng người; `dm:read` (WS) hoặc
> `PATCH /api/dm/conversations/:id/read` (REST) đưa về 0.
> **Nhận tin mới:** `dm:new` kèm `from` (card người gửi) + `unread` (số chưa đọc mới)
> để cập nhật badge/inbox ngay. Người nhận cũng nhận `notification:new` type
> `DM_MESSAGE` (persistent) → offline quay lại vẫn thấy có tin chưa đọc.

### Tin nhắn hệ thống (SYSTEM) — vd chuyển xu
Message có `type: 'SYSTEM' | 'USER'`. Khi **chuyển xu** giữa 2 user, server tự
chèn 1 tin SYSTEM vào DM của họ (giao tới cả 2 qua `dm:new`):
```jsonc
{
  "id": "...", "type": "SYSTEM",
  "content": "mừng tuổi nhé",                  // lời nhắn (note) người gửi nhập
  "systemData": { "kind": "COIN_TRANSFER", "fromUserId", "toUserId", "amount": 300, "note" },
  "senderId": "<người chuyển>", "createdAt": "..."
}
```
- `content` = lời nhắn người dùng nhập khi chuyển (có thể rỗng nếu không nhập).
  Số xu lấy từ `systemData.amount` để render thẻ chuyển khoản.
- Tin SYSTEM **KHÔNG sửa/xóa được** (server trả 403). Render khác kiểu tin thường
  (vd thẻ chuyển khoản giữa khung chat, icon xu).
- `systemData.kind` để phân loại; hiện có `COIN_TRANSFER`.

### Ghi chú bảo mật
- KHÔNG cần khóa client, KHÔNG quản lý key phía frontend. Cứ gửi/nhận text bình thường.
- Bảo mật đến từ: TLS khi truyền + mã hóa at-rest trong DB (rò rỉ dump DB không đọc được).
- Vì server đọc được, có thể làm tìm kiếm tin nhắn, kiểm duyệt — như Discord.


---

## 11. 🏆 Level / XP / Leaderboard

### Sự kiện realtime
```ts
// XP của CHÍNH mình thay đổi -> cập nhật thanh tiến trình level
chat.on('level:xp', ({ level, xp, xpIntoLevel, xpForNextLevel, xpToNextLevel, progress, gained, reason }) => {
  // progress: 0..1 để vẽ progress bar; gained: số XP vừa nhận
});

// Lên cấp
chat.on('level:up', (p) => {
  // Ở room CÁ NHÂN: { level, previousLevel, xp } -> hiệu ứng "Level Up!" cho mình
  // Ở room SERVER:  { serverId, userId, level } -> toast chúc mừng người khác
});
```
- Cũng có `notification:new` type `LEVEL_UP` (persistent) cho trung tâm thông báo.

### REST (lấy dữ liệu hiển thị)
```
GET /api/users/me/level                          progress của tôi
GET /api/users/:id/level                          progress người khác
GET /api/leaderboard?type=xp|coins&limit=50        1 bảng xếp hạng
GET /api/leaderboard/both?limit=50                 cả 2 bảng cùng lúc { xp, coins }
GET /api/leaderboard/me?type=xp|coins              hạng của tôi
```
- `user` object (profile, search, member, voice/leaderboard cards) giờ có `level` + `xp`.
- Render: huy hiệu level cạnh tên, thanh XP trong profile, 2 tab leaderboard (XP / Xu).

### Kiếm XP
- Gửi tin nhắn = +5 XP (tối đa 1 lần/60s). Backend tự cộng + phát `level:xp`/`level:up`.
- Frontend KHÔNG tự cộng XP; chỉ lắng nghe event + gọi REST để hiển thị.

---

## 🎮 Caro 1v1 (game có rank) — namespace riêng `/ws-caro`

> Game cờ caro 15×15, nối 5 quân thắng. Trận **ranked** ăn/trừ **RP** (ELO) →
> ảnh hưởng Rank của user. Server giữ toàn bộ logic, validate từng nước,
> đếm giờ 30s/nước, xử lý mất kết nối. Đây là namespace **thứ ba**, độc lập với
> `/ws` (chat) và `/ws-voice` (thoại).

### 0. Kết nối
```ts
const caro = io(`${BASE}/ws-caro`, { transports: ['websocket'], auth: { token: accessToken } });
```
- Tự join room cá nhân `caro-user:{id}` → nhận `caro:matched` khi được ghép.
- Vào trận: `caro:join` để vào room `caro:{gameId}` nhận mọi update + cho phép reconnect.

### 1. Ghép trận
```ts
// xếp hàng ranked
caro.emit('caro:queue:join', {}, (ack) => {
  if (ack.matched) goToGame(ack.gameId);     // ghép ngay
  else showSearching(ack.queueSize);          // { queued:true, queueSize }
});
caro.emit('caro:queue:leave', {}, () => {});

// cả 2 người được ghép nhận event này (kể cả khi đang ở màn khác)
caro.on('caro:matched', (game) => goToGame(game.id));
```

### 2. Thách đấu 1 người (lời mời — phải đồng ý)
```ts
// gửi lời mời
caro.emit('caro:challenge', { opponentId, ranked: false }, ({ challengeId }) => {});
// người được mời nhận lời mời -> hiện popup Đồng ý / Từ chối
caro.on('caro:challenge-received', ({ challengeId, from, ranked, expiresInMs }) => {});
caro.emit('caro:challenge:accept',  { challengeId }, ({ gameId }) => goToGame(gameId));
caro.emit('caro:challenge:decline', { challengeId }, () => {});
// người mời được báo kết quả
caro.on('caro:challenge-accepted', ({ gameId }) => goToGame(gameId));
caro.on('caro:challenge-declined', () => toast('Bị từ chối'));
caro.on('caro:matched', (game) => goToGame(game.id)); // cả 2 nhận khi đồng ý
```
- Lời mời hết hạn ~45s. Trận chỉ tạo SAU khi đối thủ đồng ý.

### 3. Vào trận & đánh
```ts
caro.emit('caro:join',  { gameId }, (view) => renderBoard(view)); // view = GameView
caro.emit('caro:move',  { gameId, row, col }, (view) => {});       // chỉ khi tới lượt mình
caro.emit('caro:resign',{ gameId }, () => {});
caro.emit('caro:leave', { gameId }, () => {});
```

### 4. Sự kiện trong room `caro:{gameId}`
```ts
caro.on('caro:move', ({ gameId, by, mark, row, col, nextTurn }) => {
  applyMove(row, col, mark); setTurn(nextTurn);   // đồng bộ nước đi đối thủ + của mình
});
caro.on('caro:end', (game) => {
  showResult(game.winner, game.endReason, game.winningLine, game.rpChange);
});
caro.on('caro:opponent-disconnected', ({ userId, graceMs }) => startForfeitCountdown(graceMs));
caro.on('caro:opponent-reconnected',  ({ userId }) => clearForfeitCountdown());

// lỗi nước đi (sai lượt / ô đã có / ngoài biên / trận đã kết thúc)
caro.on('exception', ({ message }) => toastError(message));
```

### 5. GameView (payload chuẩn ở ack/REST/event)
```jsonc
{
  "id": "...", "boardSize": 15,
  "board": [/*225 số: 0 trống, 1=X, 2=O*/], "moves": [...],
  "turn": 1, "status": "ACTIVE", "ranked": true,
  "players": { "X": {id,username,displayName,avatarUrl}, "O": {...} },
  "winner": null, "endReason": null, "winningLine": null,
  "rpChange": null, "turnSeconds": 30
}
```
- `index = row*15 + col`. X đi trước (mark 1).
- `status`: `ACTIVE | FINISHED | ABORTED`. `endReason`: `WIN | RESIGN | TIMEOUT | DISCONNECT | DRAW | ABORTED`.

### 6. Quy tắc quan trọng cho frontend
- **Đồng hồ 30s/nước**: tự đếm ngược mỗi khi `turn` đổi; hết giờ người tới lượt thua (server quyết).
- **Reconnect**: mở lại app → `GET /api/games/caro/active`; có trận → `caro:join` để tiếp tục.
  Mất kết nối khi đang chơi có **30s** quay lại, quá hạn xử thua (`DISCONNECT`).
- **RP/Rank**: chỉ `ranked:true` đổi RP. Đọc `rpChange` trong `caro:end` để hiện "+16 RP".
  Các event `rank:changed/promoted/demoted` vẫn phát trên `/ws` (chat) như mục Rank.
- **Không optimistic mù**: chờ ack `caro:move` hoặc broadcast `caro:move` rồi mới chốt,
  vì server có thể từ chối (sai lượt) qua event `exception`.

---

## 🎰 Caro — phòng cược xu + đếm người đang tìm (bổ sung)

Trên namespace `/ws-caro` (đã có ở phần Caro), bổ sung 2 cơ chế:

### Đếm số người đang tìm trận (live) + rank
```ts
caro.emit('caro:lobby:join', {}, ({ searching, players }) => showSearching(searching, players));
caro.on('caro:queue:count', ({ searching, players }) => showSearching(searching, players));
```
- `searching` = số người đang xếp hàng quick-match. `players[]` kèm `rankPoints` + `user.rank`
  để hiển thị rank từng người đang chờ. Phát realtime mỗi khi có người vào/ra hàng.

### Phòng cược xu (WAGER, 1v1)
```ts
caro.emit('caro:room:create', { betAmount: 100, isPrivate: false, name: '...' }, (room) => {});
caro.emit('caro:room:join',  { roomId } /* hoặc { code } */, (room) => {});
caro.emit('caro:room:ready', { roomId, ready: true }, (room) => {});
caro.emit('caro:room:start', { roomId }, ({ gameId }) => {});
caro.emit('caro:room:leave', { roomId }, ({ cancelled }) => {});
caro.on('caro:room:updated', (room) => renderLobby(room));
caro.on('caro:room:started', ({ gameId }) => goToGame(gameId));
caro.on('caro:room:closed',  ({ reason }) => leaveLobby());
```
- Tạo/join phòng WAGER → xu bị trừ tạm vào `pot`. Thắng lấy toàn bộ pot; hòa hoàn cược.
- Ví thay đổi báo qua `wallet:transaction` trên `/ws`. KHÔNG đổi RP ở chế độ WAGER.

---

## 🃏 Tiến Lên Miền Nam — namespace riêng `/ws-tienlen`

> Game bài 2–4 người. 2 chế độ: RANKED (đổi RP theo thứ hạng) và WAGER (về nhất ăn pot).
> Tạo phòng mức cược + số người tuỳ ý, hoặc tìm trận nhanh ranked theo cỡ bàn.
> Server giữ bài, validate mọi nước, đếm giờ 30s/lượt. Bài người khác luôn bị ẩn.

### 0. Kết nối
```ts
const tl = io(`${BASE}/ws-tienlen`, { transports: ['websocket'], auth: { token: accessToken } });
```
- Tự join `tienlen-user:{id}` → nhận `tienlen:matched`. Vào trận bằng `tienlen:join`.
- **Lỗi**: mọi lệnh emit trả về `{ success: false, error: { code, message } }` qua ack callback
  khi có lỗi (mã phòng sai, sai lượt, bộ bài sai…), đồng thời phát `tl.on('exception', ...)`.
  Frontend đọc `error.message` để hiển thị. Tương tự cho `/ws-caro`.

### 1. Đếm người đang tìm (theo cỡ bàn) + rank + tìm trận nhanh
```ts
tl.emit('tienlen:lobby:join', {}, ({ searching, players }) => show(searching, players)); // searching={2,3,4}
tl.on('tienlen:queue:count', ({ searching, players }) => show(searching, players));
// players = { "2": [{userId, user:{...rank}}], "3": [...], "4": [...] }

tl.emit('tienlen:queue:join', { size: 4 }, (ack) => {
  if (ack.matched) goToGame(ack.gameId);
  else showSearching(ack.searching, ack.players);
});
tl.emit('tienlen:queue:leave', {}, () => {});
tl.on('tienlen:matched', (game) => goToGame(game.id));
```

### 1b. Thách đấu 1 người (lời mời — phải đồng ý)
```ts
tl.emit('tienlen:challenge', { opponentId, ranked: true /* hoặc betAmount: 200 */ },
  ({ challengeId }) => {});
tl.on('tienlen:challenge-received', ({ challengeId, from, mode, betAmount, expiresInMs }) => {});
tl.emit('tienlen:challenge:accept',  { challengeId }, ({ gameId }) => goToGame(gameId));
tl.emit('tienlen:challenge:decline', { challengeId }, () => {});
tl.on('tienlen:challenge-accepted', ({ gameId }) => goToGame(gameId));
tl.on('tienlen:challenge-declined', () => toast('Bị từ chối'));
```
- WAGER (`betAmount>0`): khi đồng ý sẽ trừ cược cả 2; thiếu xu → huỷ + hoàn lại.

### 2. Phòng cược / tuỳ chỉnh (2–4 người)
```ts
tl.emit('tienlen:room:create', { betAmount: 200, maxPlayers: 4, ranked: false }, (room) => {});
tl.emit('tienlen:room:join',  { roomId } /* hoặc { code } */, (room) => {});
tl.emit('tienlen:room:ready', { roomId, ready: true }, (room) => {});
tl.emit('tienlen:room:start', { roomId }, ({ gameId }) => {});
tl.emit('tienlen:room:leave', { roomId }, ({ cancelled }) => {});
tl.on('tienlen:room:updated', (room) => renderLobby(room));
tl.on('tienlen:room:started', ({ gameId }) => goToGame(gameId));
tl.on('tienlen:room:closed',  ({ reason }) => leaveLobby());
```

### 3. Chơi
```ts
tl.emit('tienlen:join',   { gameId }, (view) => renderTable(view)); // view.myHand = bài mình
tl.emit('tienlen:play',   { gameId, cards: [/* bộ hợp lệ bất kỳ */] }, (view) => {}); // người cầm cái đi trước, đánh gì cũng được
tl.emit('tienlen:pass',   { gameId }, (view) => {});                 // chỉ khi có bộ trên bàn
tl.emit('tienlen:resign', { gameId }, (view) => {});
tl.emit('tienlen:leave',  { gameId }, () => {});
```

### 4. Sự kiện trong room `tienlen:{gameId}`
```ts
tl.on('tienlen:play', ({ seat, userId, cards, comboType, handCount, nextTurn, currentCombo, chop }) => {
  // chop != null khi nước này chặt heo: { chopper, victim, heoCount, black, red, units }
});
tl.on('tienlen:pass', ({ seat, userId, nextTurn, trickReset }) => {});
tl.on('tienlen:resigned', ({ userId, seat, nextTurn }) => {}); // người đầu hàng luôn bị xếp HẠNG BÉT (2 người: thua ngay)
tl.on('tienlen:chop', ({ chopper, victim, black, red, coins, blackPrice, redPrice, rp }) => {}); // phạt chặt heo
tl.on('tienlen:end', (game) => showResult(game.finishOrder, game.rpChange, game.coinChange, game.instantWin));
tl.on('tienlen:player-disconnected', ({ userId, graceMs }) => startForfeitCountdown(userId, graceMs));
tl.on('tienlen:player-reconnected', ({ userId }) => clearForfeitCountdown(userId));
tl.on('exception', ({ message }) => toastError(message));
```

### 4b. Tới trắng + chặt heo
- **Tới trắng:** chia bài xong nếu ai có bài đặc biệt → ván kết thúc ngay, `tienlen:end` có
  `instantWin: { userId, kind }` (kind: `TU_QUY_HEO`/`SANH_RONG`/`SAU_DOI`/`NAM_DOI_THONG`).
  RANKED: người đó được RP nhất + thưởng thêm. WAGER: lấy toàn bộ pot.
- **Chặt heo:** dùng bom (tứ quý / 3+ đôi thông) chặt con 2 của người khác → event `tienlen:chop`.
  Heo **đỏ** (♦♥) đắt **gấp đôi** heo **đen** (♠♣).
  - WAGER: tiền phạt theo **tỉ lệ mức cược** — heo đen = `bet × TIENLEN_CHOP_HEO_BET_RATIO`, heo đỏ = gấp đôi.
    `units = #đen + 2×#đỏ`, tổng `coins = blackPrice × units`. RANKED: trừ/cộng `TIENLEN_CHOP_HEO_RP × units` RP.
  - Chặt 1 con = 1 heo, chặt đôi 2 = 2 heo. Kéo theo `rank:*` (RANKED) / `wallet:transaction` (WAGER) trên `/ws`.

### 5. Mã lá bài & luật tóm tắt
- `card = rankIndex*4 + suitIndex`; rank 0='3'..12='2'; suit 0=♠ 1=♣ 2=♦ 3=♥. So sánh = số nguyên.
- Bộ: đơn / đôi / ba / tứ quý / sảnh (≥3, không có 2) / đôi thông (≥3 đôi). Chặt: 3 đôi thông & tứ quý & 4 đôi thông.
- Người giữ `openingCard` (lá thấp nhất được chia — thường 3♠ khi đủ 4 người; với 2–3 người
  có thể là lá khác) **đi trước** nhưng được đánh **bộ hợp lệ bất kỳ**, không bắt buộc lá thấp nhất.
  Hết bài trước = về nhất.

### 6. Quy tắc frontend
- **30s/lượt**: tự đếm ngược theo `turn`; hết giờ server tự đánh/bỏ lượt. Server là nguồn chân lý.
- **Ẩn bài**: chỉ render `myHand` của mình; người khác chỉ có `handCount`.
- **RANKED**: đọc `rpChange` trong `tienlen:end`; badge rank cập nhật qua `rank:*` trên `/ws`.
- **WAGER**: đọc `coinChange`; ví cập nhật qua `wallet:transaction` trên `/ws`. Về nhất lấy toàn bộ pot.
- **Reconnect**: `GET /api/games/tienlen/active` → `tienlen:join`. Phòng chưa bắt đầu: `GET /api/games/tienlen/rooms/mine`.
  Mất kết nối có **30s** để quay lại (`tienlen:player-disconnected` kèm `graceMs`); tới lượt mà vắng thì
  server bỏ lượt giúp (không tự đánh). Quá hạn → **bị xử thua** (xếp bét, `tienlen:resigned` reason `DISCONNECT`),
  người ở lại thắng.
- **Không optimistic mù**: chờ ack/broadcast `tienlen:play`/`tienlen:pass`; server có thể từ chối qua `exception`.

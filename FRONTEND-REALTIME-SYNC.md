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
  // member = { userId, user: {id,username,displayName,avatarUrl}, muted, deafened, speaking }
  // -> thêm member vào danh sách dưới kênh `channelId` trong sidebar
});

// Có người rời kênh thoại
chat.on('voice:channel-left', ({ serverId, channelId, userId }) => {
  // -> gỡ userId khỏi danh sách dưới kênh `channelId`
});

// Thành viên trong kênh thoại bật/tắt mic hoặc tai nghe (ai cũng nhận,
// kể cả người KHÔNG ở trong phòng) -> cập nhật icon mute/deafen ở sidebar
chat.on('voice:channel-state', ({ serverId, channelId, userId, muted, deafened }) => {
  // -> cập nhật cờ muted/deafened của `userId` dưới kênh `channelId`
});
```

> `voice:channel-state` KHÔNG gửi `speaking` (tránh spam khi đang nói). Để hiện
> hiệu ứng "đang nói" cho người ở trong phòng, dùng `voice:state-changed` ở mục 2.

> Đây là sửa lỗi trong ảnh: trước đây bảng bên phải không hiện `dcgxxie`.
> Sau khi xử lý 1a + 1b, mọi member đều thấy occupancy realtime.

---

## 2. 🎙️ Voice: hợp đồng signaling trong phòng (`/ws-voice`) — GIỮ NGUYÊN

Khi user bấm vào kênh thoại để **nói**, dùng `voice` socket:

### Emit (client → server)
```ts
voice.emit('voice:join',  { channelId });
voice.emit('voice:leave', { channelId });
voice.emit('voice:offer',  { toUserId, sdp });
voice.emit('voice:answer', { toUserId, sdp });
voice.emit('voice:ice',    { toUserId, candidate });
voice.emit('voice:state',  { muted?, deafened?, speaking? });
```

### Listen (server → client)
```ts
// CHỈ người vừa join nhận — danh sách peer hiện có (trừ mình)
voice.on('voice:peers', ({ channelId, peers }) => {
  // peers: VoiceMember[] -> với mỗi peer, tạo RTCPeerConnection
  // Quy ước initiator: ai có userId NHỎ HƠN là người tạo offer.
});

// Người CŨ trong phòng nhận khi có người mới vào
voice.on('voice:user-joined', ({ channelId, user }) => {
  // user: VoiceMember (có user.userId + user.user{...})
});

voice.on('voice:user-left', ({ channelId, userId }) => { /* đóng peer connection */ });

// Tín hiệu WebRTC — LUÔN có fromUserId
voice.on('voice:offer',  ({ fromUserId, sdp }) => { /* setRemote + tạo answer */ });
voice.on('voice:answer', ({ fromUserId, sdp }) => { /* setRemote */ });
voice.on('voice:ice',    ({ fromUserId, candidate }) => { /* addIceCandidate */ });

// Trạng thái mic/loa của thành viên (bỏ qua nếu là chính mình)
voice.on('voice:state-changed', ({ userId, muted, deafened, speaking }) => { /* update UI */ });
```

`VoiceMember = { userId: string, user: { id, username, displayName, avatarUrl }, muted, deafened, speaking }`

### (Tùy chọn) Nhóm lớn — SFU
Nếu backend bật LiveKit, khi phòng đông tới ngưỡng, người join sẽ nhận thêm:
```ts
voice.on('voice:mode', ({ channelId, mode, sfuEnabled }) => { /* mode: 'mesh' | 'sfu' */ });
voice.on('voice:sfu',  ({ channelId, url, token, room }) => {
  // kết nối bằng LiveKit client SDK tới `url` với `token`, bỏ qua mesh signaling
});
voice.emit('voice:sfu-token', { channelId }); // xin lại token nếu cần
```
> Nếu chưa làm SFU: bỏ qua phần này, mọi thứ chạy mesh P2P bình thường.

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
chat.on('server:member-joined',  ({ serverId, userId }) => {});
chat.on('server:member-left',    ({ serverId, userId }) => {});
chat.on('server:member-updated', ({ serverId, userId, role?, nickname? }) => {});
chat.on('server:member-banned',  ({ serverId, userId, reason }) => {});
chat.on('server:you-were-banned',({ serverId, reason }) => { /* rời server khỏi UI */ });
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
- [ ] Giữ nguyên luồng signaling `/ws-voice` (mục 2) cho người thực sự vào nói.
- [ ] Xử lý các sự kiện channel/member (mục 5) cho UI mượt.
- [ ] Cho phép gửi tin chỉ có đính kèm; hỗ trợ video/audio/file (mục 6).

> **Nguyên tắc chung:** Đừng "đóng băng" name/avatar vào từng dòng tin nhắn hay từng
> chỗ hiển thị. Luôn render từ store trung tâm theo `userId`/`serverId`, rồi cập nhật
> store khi nhận sự kiện realtime. Như vậy mọi nơi tự đồng bộ.

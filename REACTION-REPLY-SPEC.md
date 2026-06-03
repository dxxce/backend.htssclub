# 🎯 Hợp đồng API — Reaction (thả cảm xúc) & Reply (trả lời tin nhắn)

> Tài liệu này định nghĩa **hợp đồng** giữa frontend (HTSS Launcher) và backend
> (NestJS). Backend triển khai đúng tên endpoint / event / payload dưới đây.
> Frontend đã/đang code theo đúng spec này → backend xong là chạy ngay, không cần sửa lại.
>
> Base path REST: `/api` · Header: `Authorization: Bearer <accessToken>`
> Response: `{ success, data }` hoặc `{ success, error }`
> Realtime: namespace chat `/ws`, room `channel:{channelId}` (client đã `channel:join`).

---

## 1. 💬 Reply (trả lời tin nhắn) — phần lớn đã có

`replyToId` đã tồn tại trong schema Message. Cần đảm bảo:

### Gửi tin có trả lời
- REST: `POST /api/channels/:channelId/messages`
  body: `{ content?, attachments?, replyToId? }`
- WS: `message:send` payload `{ channelId, content?, attachments?, replyToId? }`

### Message trả về PHẢI kèm thông tin tin gốc để hiển thị trích dẫn
Khi `replyToId` có giá trị, backend trả thêm field `replyTo` (đã populate gọn):

```jsonc
{
  "id": "msg2",
  "channelId": "c1",
  "authorId": "u2",
  "author": { "id": "u2", "username": "...", "displayName": "...", "avatarUrl": "..." },
  "content": "đồng ý nhé",
  "replyToId": "msg1",
  "replyTo": {                      // 👈 CẦN THÊM (null nếu tin gốc đã bị xóa)
    "id": "msg1",
    "authorId": "u1",
    "author": { "id": "u1", "username": "...", "displayName": "...", "avatarUrl": "..." },
    "content": "đi ăn không?",
    "hasAttachments": true          // để hiển thị "📎 đính kèm" khi content rỗng
  },
  "createdAt": "..."
}
```

- `replyTo.content` nên cắt ngắn ≤ ~120 ký tự (frontend cũng tự cắt khi hiển thị).
- Nếu tin gốc bị xóa: trả `replyTo: null` (frontend hiện "Tin nhắn đã bị xóa").
- Lịch sử `GET /api/channels/:channelId/messages` cũng trả kèm `replyTo` như trên.

---

## 2. 😀 Reaction (thả cảm xúc)

Một reaction = 1 emoji (chuỗi unicode, vd `"👍"`, `"❤️"`) do 1 user thả lên 1 message.

### 2.1 REST
| Method | Path | Body | Mô tả |
| --- | --- | --- | --- |
| POST | `/api/channels/:channelId/messages/:messageId/reactions` | `{ emoji }` | Thêm reaction của mình (idempotent: thả lại cùng emoji thì giữ nguyên). |
| DELETE | `/api/channels/:channelId/messages/:messageId/reactions` | `{ emoji }` | Gỡ reaction của mình với emoji đó. |

> Quyền: thành viên của server chứa kênh. `emoji` validate là 1 emoji hợp lệ, độ dài ≤ 32.

### 2.2 Hình dạng dữ liệu reaction trong Message
Mỗi Message kèm mảng `reactions` đã GỘP theo emoji:

```jsonc
{
  "id": "msg1",
  // ...các field cũ...
  "reactions": [
    { "emoji": "👍", "count": 3, "userIds": ["u1","u2","u5"], "me": true },
    { "emoji": "🔥", "count": 1, "userIds": ["u3"], "me": false }
  ]
}
```
- `count`: tổng số người thả emoji đó.
- `userIds`: danh sách userId đã thả (để hiện tooltip "ai đã thả"). Có thể giới hạn ~50 id đầu.
- `me`: chính mình đã thả emoji này chưa (để tô sáng nút).
- Message không có reaction → `reactions: []` hoặc bỏ field (frontend coi như rỗng).
- Trả `reactions` trong: lịch sử messages, `message:new`, `message:updated`.

### 2.3 Realtime (phát tới room `channel:{channelId}`)
```ts
// Có người thả reaction
chat.on('reaction:added', ({ channelId, messageId, emoji, userId }) => { ... });

// Có người gỡ reaction
chat.on('reaction:removed', ({ channelId, messageId, emoji, userId }) => { ... });
```
Payload:
```jsonc
{ "channelId": "c1", "messageId": "msg1", "emoji": "👍", "userId": "u2" }
```
- Frontend tự cập nhật `count`/`userIds`/`me` của message tương ứng từ 2 event này
  (không cần backend gửi lại toàn bộ mảng reactions).
- (Tuỳ chọn) Client có thể emit `reaction:add` / `reaction:remove` qua WS với
  payload `{ channelId, messageId, emoji }` thay cho REST — nếu backend hỗ trợ thì
  báo lại, mặc định frontend dùng REST cho chắc.

### 2.4 Khi xóa message
- Xóa message → xóa kèm toàn bộ reaction của nó (cascade). Không cần phát thêm event reaction.

---

## 3. ✅ Checklist backend
- [ ] `POST /channels/:channelId/messages/:messageId/reactions` body `{ emoji }`.
- [ ] `DELETE /channels/:channelId/messages/:messageId/reactions` body `{ emoji }`.
- [ ] Message trả kèm `reactions: [{ emoji, count, userIds, me }]` ở: lịch sử, `message:new`, `message:updated`.
- [ ] Message trả kèm `replyTo` (populate gọn: id, author, content cắt ngắn, hasAttachments) khi có `replyToId`; `null` nếu tin gốc đã xóa.
- [ ] Phát `reaction:added` / `reaction:removed` tới room `channel:{channelId}`.
- [ ] Cascade xóa reaction khi xóa message.

## 4. Ghi chú frontend (đã/sẽ làm theo spec này)
- Reply: hover/chuột phải tin nhắn → "Trả lời" → hiện thanh trích dẫn phía trên ô nhập;
  gửi kèm `replyToId`. Tin có `replyTo` hiển thị khối trích dẫn nhỏ phía trên nội dung,
  bấm vào để cuộn tới tin gốc.
- Reaction: hover tin nhắn → nút "+" mở bảng emoji nhanh; click chip reaction để
  thả/gỡ. Cập nhật lạc quan (optimistic) rồi đồng bộ theo event realtime.

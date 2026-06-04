# 🖥️ LiveKit production trên Mac mini M4 — domain livekit.htss.club

Self-host LiveKit tại nhà, phục vụ qua internet với TLS. Mô hình:

```
Client (wss://livekit.htss.club)
        │  443 (TLS)
        ▼
   [ Caddy ]  ── tự xin Let's Encrypt, reverse proxy
        │  127.0.0.1:7880 (plaintext nội bộ)
        ▼
 [ livekit-server ]  ── media qua UDP 7882 / TURN 3478
```

---

## BƯỚC 0 — Kiểm tra IP public (QUAN TRỌNG NHẤT)

```bash
bash livekit/check-public-ip.sh
```
- IP bắt đầu `100.64.x.x`–`100.127.x.x` → **bị CGNAT**, KHÔNG tự host được.
  Giải pháp: gọi ISP xin **IP tĩnh**, hoặc dùng **Cloudflare Tunnel** (xem cuối file).
- IP public bình thường → đi tiếp.

---

## BƯỚC 1 — DNS: trỏ domain về nhà bạn

IP nhà thường **động** (đổi theo thời gian). Hai cách:

**A. IP tĩnh (ISP cấp):** tạo A record `livekit.htss.club → <IP tĩnh>`.

**B. IP động → Dynamic DNS:** dùng dịch vụ DDNS (nhiều router có sẵn, hoặc
Cloudflare API script) để tự cập nhật A record mỗi khi IP đổi. Nếu domain
`htss.club` ở Cloudflare, bật DDNS trỏ `livekit` về IP hiện tại.

Kiểm tra: `dig +short livekit.htss.club` phải ra đúng IP public của bạn.

---

## BƯỚC 2 — Mở cổng trên router (port-forward về Mac mini)

| Cổng ngoài | Giao thức | → Mac mini |
| --- | --- | --- |
| 80  | TCP | 80  (Caddy xin cert Let's Encrypt) |
| 443 | TCP | 443 (Caddy — client kết nối wss) |
| 7882 | UDP | 7882 (media WebRTC) |
| 3478 | UDP | 3478 (TURN) |
| 7881 | TCP | 7881 (WebRTC fallback) |

Đặt **IP tĩnh nội bộ** cho Mac mini (DHCP reservation) để forward không bị lệch.

---

## BƯỚC 3 — Cài phần mềm

```bash
brew install livekit caddy
livekit-server generate-keys   # lưu lại API key + secret
```
Dán key/secret vào:
- `livekit/livekit.macmini.yaml` (mục `keys:`)
- `.env` backend: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`

---

## BƯỚC 4 — Cập nhật .env backend

```env
LIVEKIT_URL=wss://livekit.htss.club
LIVEKIT_API_KEY=APIxxxxxxxxxxxx
LIVEKIT_API_SECRET=secretxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## BƯỚC 5 — Chạy

Mở 2 terminal (hoặc dùng launchd ở bước 6):

```bash
# Terminal 1 — LiveKit (nội bộ 7880)
livekit-server --config ./livekit/livekit.macmini.yaml

# Terminal 2 — Caddy (TLS + proxy 443 -> 7880)
sudo caddy run --config ./livekit/Caddyfile
```
> `sudo` vì Caddy bind cổng 80/443. Lần đầu Caddy sẽ tự xin chứng chỉ TLS cho
> `livekit.htss.club` (cần cổng 80 mở + DNS đã trỏ đúng).

---

## BƯỚC 6 — Chạy nền tự động (launchd)

Để LiveKit + Caddy tự khởi động cùng máy, dùng Homebrew services:
```bash
brew services start caddy
# LiveKit chưa có brew service sẵn -> tạo launchd plist:
```
Tạo `~/Library/LaunchAgents/club.htss.livekit.plist` (xem mẫu trong
`livekit/club.htss.livekit.plist`) rồi:
```bash
launchctl load ~/Library/LaunchAgents/club.htss.livekit.plist
```

---

## BƯỚC 7 — Kiểm tra từ ngoài

```bash
# Từ một máy KHÁC mạng (vd 4G điện thoại tether):
node scripts/test-livekit.js wss://livekit.htss.club <API_KEY> <API_SECRET>
```
Phải thấy "WebSocket /rtc handshake accepted" + "JOIN OK".

---

## Phương án thay thế nếu bị CGNAT: Cloudflare Tunnel

Nếu không có IP public (CGNAT) và không xin được IP tĩnh:
```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create htss-livekit
cloudflared tunnel route dns htss-livekit livekit.htss.club
# map về LiveKit nội bộ:
cloudflared tunnel --url http://127.0.0.1:7880 run htss-livekit
```
> Hạn chế: Cloudflare Tunnel tốt cho **signaling (WebSocket)** nhưng **không
> chuyển UDP media** ngon. Với WebRTC media bạn vẫn cần TURN qua cổng riêng
> hoặc dùng TURN bên ngoài. CGNAT + self-host media là bài toán khó — nếu vướng,
> đặt LiveKit trên 1 VPS nhỏ là rẻ và đỡ đau đầu hơn nhiều.

---

## Lưu ý vận hành

- **Mac mini phải bật 24/7**, tắt chế độ ngủ: System Settings → Energy →
  "Prevent automatic sleeping" + "Start up automatically after power failure".
- **Băng thông upload tại nhà** là giới hạn thật: mỗi người xem stream tốn vài
  Mbps download của họ nhưng tốn upload của Mac mini × số người (LiveKit là SFU
  nên mỗi track upload 1 lần, nhưng vẫn nhân theo số subscriber). Mạng nhà upload
  yếu (vd 20–50 Mbps) chỉ kham được nhóm nhỏ.
- **TLS cert tự gia hạn** bởi Caddy, không cần làm gì thêm.

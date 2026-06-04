# 🍎 Tự host LiveKit trên macOS

Hướng dẫn chạy LiveKit server riêng (thay cho LiveKit Cloud) trên máy Mac.
Có 2 cách: **Homebrew (native, gọn nhất)** hoặc **Docker**.

---

## Cách A — Homebrew (khuyên dùng cho dev/self-host đơn giản)

### 1. Cài
```bash
brew install livekit
# kiểm tra
livekit-server --version
```

### 2. Sinh API key/secret production (KHÔNG dùng devkey/secret)
```bash
livekit-server generate-keys
# In ra ví dụ:
#   API Key:    APIabc123...
#   API Secret: secretXyz789...
```
Dán cặp này vào `livekit/livekit.yaml` (mục `keys:`) và vào `.env` của backend
(`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`).

### 3. Chạy nhanh (dev mode — chỉ LAN/localhost)
```bash
livekit-server --dev
# Mặc định: ws://localhost:7880, key devkey / secret secret
```

### 4. Chạy với config production
```bash
livekit-server --config ./livekit/livekit.yaml
```

> Trên macOS lần đầu chạy có thể bị Gatekeeper chặn → vào **System Settings →
> Privacy & Security → "Allow Anyway"**, rồi chạy lại.

---

## Cách B — Docker (đã có sẵn service trong docker-compose.yml)

```bash
# chạy bản dev có sẵn:
docker compose up -d livekit
```
Hoặc chạy với config production:
```bash
docker run --rm \
  -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  -p 3478:3478/udp -p 5349:5349 \
  -v $PWD/livekit:/etc/livekit \
  livekit/livekit-server --config /etc/livekit/livekit.yaml
```

---

## Cổng cần mở (firewall / router)

| Cổng | Giao thức | Dùng cho |
| --- | --- | --- |
| 7880 | TCP | Signaling + HTTP/API (WebSocket client kết nối) |
| 7881 | TCP | WebRTC qua TCP (fallback) |
| 7882 | UDP | WebRTC media (chính) |
| 3478 | UDP | TURN |
| 5349 | TCP | TURN/TLS |

- **Self-host tại nhà:** mở (port-forward) các cổng trên router về máy Mac, và đặt
  `external_ip` = IP public trong `livekit.yaml`. IP nhà thường động → cân nhắc
  Dynamic DNS hoặc đặt LiveKit trên VPS.
- **VPS/cloud:** bật `use_external_ip: true` để LiveKit tự dò IP public, mở các
  cổng trên security group.

---

## Vì sao cần TURN cho production

Voice/stream là WebRTC. Hai client sau NAT/firewall chặt không kết nối media trực
tiếp được → TURN relay giúp truyền qua. Trên LAN nội bộ (dev) thì không cần, nhưng
qua internet thật thì **bắt buộc**, nếu không nhiều người sẽ không nghe/xem được.

TURN cần **TLS hợp lệ** cho domain. Hai hướng:
1. Để LiveKit tự quản TLS: trỏ `turn.domain` + cert vào `livekit.yaml`.
2. Đặt LiveKit sau **reverse proxy** (Caddy/nginx) lo TLS, hoặc dùng
   `livekit-server` kèm tính năng tự xin Let's Encrypt (xem docs).

---

## Khớp với backend HTSS

Sau khi LiveKit chạy, cập nhật `.env` của backend:
```env
LIVEKIT_URL=wss://livekit.htss.club      # production: wss:// (TLS). Dev LAN: ws://IP:7880
LIVEKIT_API_KEY=APIabc123...
LIVEKIT_API_SECRET=secretXyz789...
```
> Production phải dùng `wss://` (WebSocket Secure). Trình duyệt chặn `ws://` (không
> mã hóa) khi web app chạy trên `https://`.

Kiểm tra kết nối từ backend:
```bash
node scripts/test-livekit.js wss://livekit.htss.club APIabc123... secretXyz789...
```

---

## Tóm tắt khuyến nghị

| Môi trường | Cách chạy | TURN | Giao thức |
| --- | --- | --- | --- |
| Dev (cùng máy) | `livekit-server --dev` | Không | `ws://localhost:7880` |
| Dev LAN | `--config` + `external_ip` = IP LAN | Không | `ws://192.168.x.x:7880` |
| Production | VPS + `--config` + TURN + TLS | **Có** | `wss://domain` |

Với production thật phục vụ nhiều người qua internet, một VPS nhỏ (2 vCPU/4GB) +
TURN + TLS là đủ cho nhóm vừa. macOS hợp cho dev/test; production nên đặt trên
Linux VPS để ổn định và mở cổng dễ hơn.

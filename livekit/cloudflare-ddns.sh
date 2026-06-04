#!/usr/bin/env bash
# Dynamic DNS cho Cloudflare — tự cập nhật A record khi IP nhà đổi.
# Dùng cho domain động (cáp quang VN thường là IP động).
#
# Cài đặt:
#   1. Tạo API token Cloudflare: My Profile -> API Tokens -> Create Token
#      quyền: Zone.DNS (Edit) cho zone htss.club
#   2. Điền 3 biến dưới.
#   3. Chạy định kỳ bằng cron mỗi 5 phút (xem cuối file).
set -euo pipefail

CF_API_TOKEN="CHANGE_ME_token"
ZONE_NAME="htss.club"
RECORD_NAME="livekit.htss.club"

api() { curl -s -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json" "$@"; }

CURRENT_IP="$(curl -s https://api.ipify.org)"
echo "Current public IP: ${CURRENT_IP}"

ZONE_ID="$(api "https://api.cloudflare.com/client/v4/zones?name=${ZONE_NAME}" | sed -n 's/.*"id":"\([a-f0-9]*\)".*/\1/p' | head -1)"
[ -n "${ZONE_ID}" ] || { echo "Zone not found"; exit 1; }

REC_JSON="$(api "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=A&name=${RECORD_NAME}")"
RECORD_ID="$(echo "${REC_JSON}" | sed -n 's/.*"id":"\([a-f0-9]*\)".*/\1/p' | head -1)"
OLD_IP="$(echo "${REC_JSON}" | sed -n 's/.*"content":"\([0-9.]*\)".*/\1/p' | head -1)"

if [ "${OLD_IP}" = "${CURRENT_IP}" ]; then
  echo "IP unchanged (${CURRENT_IP}); nothing to do."
  exit 0
fi

# proxied=false (DNS only) — BẮT BUỘC cho LiveKit/WebRTC, vì Cloudflare proxy
# (cam vàng) KHÔNG chuyển tiếp UDP media. Phải để "DNS only" (cam xám).
PAYLOAD="{\"type\":\"A\",\"name\":\"${RECORD_NAME}\",\"content\":\"${CURRENT_IP}\",\"ttl\":120,\"proxied\":false}"

if [ -n "${RECORD_ID}" ]; then
  api -X PUT "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}" --data "${PAYLOAD}" >/dev/null
  echo "Updated ${RECORD_NAME}: ${OLD_IP:-none} -> ${CURRENT_IP}"
else
  api -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" --data "${PAYLOAD}" >/dev/null
  echo "Created ${RECORD_NAME} -> ${CURRENT_IP}"
fi

# ── Cron (chạy mỗi 5 phút) ──────────────────────────────────────
#   crontab -e
#   */5 * * * * /bin/bash <PATH_TO_REPO>/livekit/cloudflare-ddns.sh >> /tmp/ddns.log 2>&1

#!/usr/bin/env bash
# Chạy trên Mac mini: bash check-public-ip.sh
# So sánh IP public (theo internet thấy) với IP WAN trên router.

echo "IP public (internet nhìn thấy):"
curl -s https://api.ipify.org; echo

echo
echo "Nếu IP trên BẮT ĐẦU bằng 100.64.x.x  -> 100.127.x.x  thì bạn đang bị CGNAT"
echo "(không tự host ra internet được — cần xin IP tĩnh từ ISP hoặc dùng VPS/tunnel)."
echo
echo "Bước tiếp: đăng nhập router, xem mục WAN/Status. Nếu IP WAN trên router"
echo "KHÁC với IP public ở trên -> cũng là CGNAT (qua nhiều lớp NAT)."

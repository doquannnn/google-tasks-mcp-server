#!/usr/bin/env bash
# Chạy MCP server Google Tasks (HTTP, 127.0.0.1:8787) ở foreground. Ctrl+C để tắt.
# Claude trong thư mục này kết nối tới server qua .mcp.json (type http) — mở Claude ở tab/cửa sổ khác.
#   ./start.sh              → kiểm tra đăng nhập Google rồi giữ server chạy
#   PORT=9000 ./start.sh    → đổi cổng (nhớ sửa url trong .mcp.json)
set -euo pipefail
cd "$(dirname "$0")"

[ -d node_modules ] || { echo "→ Cài dependencies..."; npm install --silent; }

if [ ! -f credentials.json ]; then
  echo "✖ Thiếu credentials.json (OAuth client 'Desktop app'). Xem README mục 3." >&2
  exit 1
fi

echo "→ Kiểm tra kết nối Google Tasks..."
set +e
node scripts/check-auth.ts
code=$?
set -e
if [ $code -eq 2 ]; then
  echo "→ Token hết hạn hoặc chưa có, đăng nhập lại Google..."
  node scripts/auth.ts
  node scripts/check-auth.ts
elif [ $code -ne 0 ]; then
  echo "✖ Không kết nối được Google Tasks (xem lỗi ở trên)." >&2
  exit $code
fi

# Bearer token cho server local, phải khớp header trong .mcp.json.
if [ ! -s .mcp-token ]; then
  echo "✖ Thiếu .mcp-token (bearer token khớp với .mcp.json). Xem README phần Dùng hằng ngày." >&2
  exit 1
fi

export GOOGLE_CREDENTIALS_FILE="$PWD/credentials.json"
export GOOGLE_TOKEN_FILE="$PWD/token.json"
export TZ=Asia/Ho_Chi_Minh
export MCP_AUTH_TOKEN="$(cat .mcp-token)"
export PORT="${PORT:-8787}"

echo "→ Server đang chạy tại http://127.0.0.1:$PORT/mcp — Ctrl+C để tắt."
exec node src/server.ts --http

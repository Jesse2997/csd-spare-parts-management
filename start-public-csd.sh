#!/bin/zsh
set -e

cd "$(dirname "$0")"
node_bin="/Users/jesse/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
export PATH="$node_bin:$PATH"
vinext_cli=$(find node_modules/.pnpm -path '*/node_modules/vinext/dist/cli.js' -type f | head -1)

if [[ ! -x .venv/bin/python ]]; then
  echo "缺少系統環境，請先執行：python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi

if [[ -z "$vinext_cli" ]]; then
  echo "找不到網頁執行環境，請先安裝專案套件"
  exit 1
fi

pkill -f "vinext" 2>/dev/null || true
pkill -f "backend/main.py" 2>/dev/null || true
pkill -f "reverse-proxy.mjs" 2>/dev/null || true
pkill -f "cloudflared tunnel" 2>/dev/null || true

"$node_bin/node" "$vinext_cli" build
.venv/bin/python backend/main.py > work/tunnel/api.log 2>&1 &
api_pid=$!
"$node_bin/node" "$vinext_cli" start --port 3001 > work/tunnel/app.log 2>&1 &
app_pid=$!
node work/tunnel/reverse-proxy.mjs > work/tunnel/proxy.log 2>&1 &
proxy_pid=$!

cleanup() {
  kill "$api_pid" "$app_pid" "$proxy_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 4
echo "CSD 已啟動，正在建立公開網址…"
work/tunnel/cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate

#!/bin/zsh
set -e
cd "$(dirname "$0")"
if [[ ! -x .venv/bin/python ]]; then
  echo "請先建立 Python 環境：python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi
.venv/bin/python backend/main.py &
api_pid=$!
trap 'kill $api_pid 2>/dev/null' EXIT
PATH="/Users/jesse/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" ./node_modules/.bin/vinext dev

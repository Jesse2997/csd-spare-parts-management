#!/bin/sh
# CSD 系統版本庫：原始碼歷史與資料版本資料分開保存。
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HISTORY_DIR=$(CDPATH= cd -- "$PROJECT_DIR/../.." && pwd)/csd-system-history.git
GIT="git --git-dir=$HISTORY_DIR --work-tree=$PROJECT_DIR"

if [ ! -d "$HISTORY_DIR" ]; then
  echo "找不到系統版本庫，請先執行初始化。"
  exit 1
fi

case "${1:-status}" in
  status)
    $GIT status --short
    ;;
  history)
    $GIT log --oneline --decorate -20
    ;;
  snapshot)
    MESSAGE=${2:-"系統更新"}
    $GIT add -A
    if $GIT diff --cached --quiet; then
      echo "沒有需要建立版本的程式變更。"
      exit 0
    fi
    $GIT commit -m "$MESSAGE"
    echo "已建立系統版本：$MESSAGE"
    ;;
  restore)
    if [ -z "${2:-}" ]; then
      echo "請指定要回復的版本，例如：./scripts/system-version.sh restore v0.2.0"
      exit 1
    fi
    if [ -n "$($GIT status --porcelain)" ]; then
      echo "目前有尚未建立版本的修改。請先執行 snapshot，再進行回復。"
      exit 1
    fi
    $GIT restore --source "$2" -- .
    echo "已將程式檔案回復為 $2；請檢查後建立新的系統版本。"
    ;;
  *)
    echo "用法：$0 {status|history|snapshot [說明]|restore <版本>}" >&2
    exit 1
    ;;
esac

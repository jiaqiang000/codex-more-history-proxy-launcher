#!/bin/bash

# 同时启用：
# 1. 仅对本次 Codex 启动生效的代理
# 2. 仅对本次 Codex 启动生效的侧边栏 recent threads 扩容补丁

if [ -n "${ZSH_EVAL_CONTEXT:-}" ]; then
  case ":${ZSH_EVAL_CONTEXT}:" in
    *:file:*)
      echo "Do not source this script. Run: bash $0" >&2
      return 1 2>/dev/null || exit 1
      ;;
  esac
fi

if [ -n "${BASH_VERSION:-}" ] && [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "Do not source this script. Run: bash ${BASH_SOURCE[0]}" >&2
  return 1 2>/dev/null || exit 1
fi

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="${SCRIPT_DIR}/launch_codex_all_threads.js"

export CODEX_PROXY="${CODEX_PROXY:-http://127.0.0.1:7890}"
export CODEX_NO_PROXY="${CODEX_NO_PROXY:-127.0.0.1,localhost}"

exec node "$LAUNCHER"

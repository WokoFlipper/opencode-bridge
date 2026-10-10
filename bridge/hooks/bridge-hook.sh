#!/bin/sh
# opencode-bridge hook (совместим с Claude Code hook-протоколом).
# Получает JSON события на stdin и пересылает мосту на телефон.
# Вне bridge-сессии (обычный терминал) молча выходит.
# Основной путь уведомлений — plugin/opencode-bridge.ts; этот скрипт — legacy/ручной.
[ -z "$OPENCODE_BRIDGE_SESSION" ] && [ -z "$CLAUDE_BRIDGE_SESSION" ] && exit 0
_SESS="${OPENCODE_BRIDGE_SESSION:-$CLAUDE_BRIDGE_SESSION}"
curl -sk --noproxy '*' -m 2 \
  -X POST "https://127.0.0.1:${OPENCODE_BRIDGE_PORT:-${CLAUDE_BRIDGE_PORT:-8890}}/hook" \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Session: $_SESS" \
  -d @- >/dev/null 2>&1 || true
exit 0

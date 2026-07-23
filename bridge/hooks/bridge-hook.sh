#!/bin/sh
# Claude Code hook -> Claude Bridge.
# Получает JSON события на stdin и пересылает мосту на телефон.
# Вне bridge-сессии (обычный терминал) молча выходит.
[ -z "$CLAUDE_BRIDGE_SESSION" ] && exit 0
curl -sk --noproxy '*' -m 2 \
  -X POST "https://127.0.0.1:${CLAUDE_BRIDGE_PORT:-8790}/hook" \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Session: $CLAUDE_BRIDGE_SESSION" \
  -d @- >/dev/null 2>&1 || true
exit 0

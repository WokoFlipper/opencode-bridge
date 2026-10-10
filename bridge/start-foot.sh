#!/bin/sh
# opencode-bridge: поднять мост в видимом окне foot.
# Использование: ./start-foot.sh   (из каталога bridge/)
# systemd-юнит перед этим остановить: systemctl --user stop opencode-bridge
# Лог дублируется в bridge.log; при падении окно НЕ закрывается (exec sh),
# код выхода виден — так ловим краши вместо гадания.
pkill -f "[s]erver.js" 2>/dev/null
sleep 1
HERE="$(dirname "$0")"
setsid foot -T opencode-bridge --working-directory "$HERE" sh -c "node '$HERE/server.js' 2>&1 | tee '$HERE/bridge.log'; echo; echo '--- мост упал, код: $? (окно держим, Enter — новая shell)'; exec sh" </dev/null >/dev/null 2>&1 &
disown 2>/dev/null
echo "opencode-bridge запущен в окне foot (проверка: ss -tln | grep 8890)"

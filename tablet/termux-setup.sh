#!/data/data/com.termux/files/usr/bin/bash
# OpenCode Bridge — bootstrap сервера на Android-планшете (Termux с F-Droid).
# Запуск: скопируй этот файл на планшет и выполни в Termux:
#   bash termux-setup.sh
# Что делает: ставит пакеты, клонирует/обновляет репо, ставит зависимости
# моста, пересобирает node-pty под Android, создаёт стартовый config.json,
# берёт wake-lock и запускает мост. Дальше — сопряжение с телефона как обычно.
set -u

REPO_URL="${REPO_URL:-https://github.com/WokoFlipper/opencode-bridge.git}"
ROOT="$HOME/opencode-bridge"
BRIDGE="$ROOT/bridge"

step() { echo; echo "=== $1 ==="; }

step "1/6 Пакеты Termux (nodejs, python, clang, make, git, api)"
pkg update -y
pkg install -y nodejs-lts python clang make git openssh termux-api || {
  echo "ОШИБКА: не встали пакеты. Проверь сеть и версию Termux (нужен F-Droid, не Play Store)."
  exit 1
}
node --version

step "2/6 Репозиторий"
if [ -d "$ROOT/.git" ]; then
  git -C "$ROOT" pull --ff-only || echo "WARN: git pull не удался, работаем с имеющимся деревом"
else
  git clone "$REPO_URL" "$ROOT" || { echo "ОШИБКА: не склонировался репо"; exit 1; }
fi

step "3/6 Зависимости моста"
cd "$BRIDGE"
npm install --no-audit --no-fund || { echo "ОШИБКА: npm install упал"; exit 1; }

step "4/6 node-pty под Android"
if node -e "require('node-pty')" 2>/dev/null; then
  echo "node-pty завёлся из коробки (prebuilt)."
else
  echo "prebuilt не подошёл — собираем из исходников (нужны clang/make/python, уже стоят)…"
  npm rebuild node-pty --build-from-source || {
    echo "ОШИБКА: node-pty не собрался. Это самый рискованный шаг на планшете."
    echo "Проверь: clang --version, python3 --version, свободное место (нужно ~1 ГБ)."
    exit 1
  }
  node -e "require('node-pty'); console.log('node-pty OK после сборки')"
fi

step "5/6 config.json (если его ещё нет)"
if [ ! -f "$BRIDGE/config.json" ]; then
  sed -e "s#\"defaultCwd\": *\"\"#\"defaultCwd\": \"$HOME\"#" \
      -e "s#\"projects\": *\[\]#\"projects\": [\"$HOME\"]#" \
      "$BRIDGE/config.example.json" > "$BRIDGE/config.json"
  chmod 600 "$BRIDGE/config.json"
  echo "Создан config.json: defaultCwd=$HOME, projects=[$HOME]"
  echo "Отредактируй под себя: nano $BRIDGE/config.json"
else
  echo "config.json уже есть — не трогаю."
fi

step "6/6 Wake-lock и старт"
termux-wake-lock 2>/dev/null && echo "Wake-lock взят (Termux не уснёт)." || {
  echo "WARN: termux-wake-lock не сработал — поставь приложение Termux:API и сними оптимизацию батареи для Termux в настройках Android."
}
echo
echo "Запускаю мост. НЕ закрывай сессию Termux; код сопряжения и QR — ниже."
echo "Автозапуск после перезагрузки планшета — см. tablet/README.md (Termux:Boot)."
echo
exec node "$BRIDGE/server.js"

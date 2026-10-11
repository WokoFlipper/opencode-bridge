<div align="center">

# OpenCode Bridge

**Зеркаль и управляй своими сессиями [opencode](https://opencode.ai) со смартфона.**
Никаких облаков и посредников: телефон общается напрямую с твоим ПК — по локальной сети или через p2p-туннель, когда ты вне дома.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/ПК-Linux-informational)](#требования)
[![Android](https://img.shields.io/badge/Телефон-Android%208%2B-green)](#установка-приложения-на-телефон)

🇷🇺 Русский · [🇬🇧 English](README.en.md)

</div>

---

## Что это

`OpenCode Bridge` — форк [`HelpFreedom/claude-bridge`](https://github.com/HelpFreedom/claude-bridge), пересобранный под TUI-сессии `opencode`. На твоём компьютере поднимается лёгкий мост (Node.js), который «отражает» терминальные сессии opencode на Android-приложение «OpenCode Mobile». С телефона ты видишь тот же терминал, что и на ПК, вводишь текст и команды, переключаешь сессии, отвечаешь на запросы разрешений — и получаешь push-уведомления, когда opencode ждёт ответа или закончил работу.

Всё общение идёт **напрямую между твоими устройствами**. По WiFi это локальная сеть; вне дома — зашифрованный p2p-туннель (iroh/QUIC) без промежуточных серверов и без белого IP. Трафик защищён TLS с пиннингом сертификата, доступ — по одноразовому сопряжению: сопрягся раз — работает из любой сети.

Алгоритм связи и принципы безопасности автора сохранены 1:1 — менялись только имена, порты и точки интеграции с агентом.

### Ключевые возможности

- 📱 **Полный терминал на телефоне** — xterm.js в WebView: ввод, стрелки, Esc/Tab/Ctrl-C, прокрутка и выделение пальцем, вставка из буфера.
- 🔀 **Несколько сессий** — вкладки, переключение, запуск новых (`--continue`, `--fork`), несколько сопряжённых ПК.
- 🔔 **Push-уведомления из плагина** — «opencode ждёт подтверждения», «opencode завершил ответ» с кнопками быстрого ответа прямо из шторки.
- 🌐 **Работа вне дома** — если ПК не виден в WiFi, автоматически поднимается p2p-туннель (iroh) с приоритетом LAN.
- 🎙️ **Голосовой ввод** — надиктовка сообщений (faster-whisper на ПК), опционально.
- 🔒 **Приватность и безопасность** — самоподписанный TLS + пиннинг отпечатка, сопряжение по QR/коду, биометрический замок приложения, `FLAG_SECURE`, токены только у доверенных устройств.
- 💾 **Сессии переживают всё** — процессы-хранители держат PTY независимо от моста: перезапуск моста или закрытие приложения не убивает работу opencode.

> Подробное техническое описание архитектуры оригинала — в [ARCHITECTURE.md](ARCHITECTURE.md). Чем форк отличается — в [FORK.md](FORK.md).

---

## Чем отличается от оригинала

| Было (`claude-bridge`) | Стало (`opencode-bridge`) |
|---|---|
| Порты `8790` HTTPS/WSS, `8791` UDP, `8792` туннель | `8890` / `8891` / `8892` — оба моста живут рядом |
| `~/.claude-bridge/sessions/` | `~/.opencode-bridge/sessions/` |
| `CLAUDE_BRIDGE_SESSION` / `CLAUDE_BRIDGE_PORT` / `CLAUDE_BRIDGE_URL` | `OPENCODE_BRIDGE_SESSION` / `OPENCODE_BRIDGE_PORT` / `OPENCODE_BRIDGE_URL` (старые имена читаются как fallback) |
| `config: claudeCommand/claudeArgs` | `config: opencodeCommand/opencodeArgs` (старые ключи — fallback) |
| CLI `claude-mobile`, бинарь по умолчанию `claude` | `bridge/opencode-mobile`, бинарь `opencode` |
| Новая сессия из Web UI: `--resume`, `--dangerously-skip-permissions` | `--continue`, `--fork` |
| Хуки Claude Code (`settings.json`) | Плагин-шим `plugin/opencode-bridge.ts` (события `session.idle` / `session.status` / `permission.asked` / `tui.toast.show` → тот же `POST /hook`) |
| `bridge-hook.sh` на `$CLAUDE_BRIDGE_*` | Тот же скрипт, на `$OPENCODE_BRIDGE_*` (старые переменные — fallback) |
| mDNS-сервис `claude-bridge`, UDP-магия `CLAUDE_BRIDGE?`, QR `{cb:1,…}` | `opencode-bridge`, `OPENCODE_BRIDGE?`, `{ob:1,…}` (приём понимает и старые имена) |
| CN сертификата `claude-bridge` | `opencode-bridge` (сертификат генерируется заново — телефон сопрягается заново) |
| Приложение «Claude Bridge», иконка с логотипом автора | Приложение «OpenCode Mobile», своя иконка (фиолетовое свечение, жёлтая антенна) |

Без изменений: TLS-пиннинг, pairing-код 10 мин/одноразовый/throttle, `isLocal` по UID (fail-closed), права `0600/0700`, keeper-протокол и переживание рестарта, WS-протокол, scrollback, rate-limits, xterm UI, `stt.py`, CSP-заголовки.

---

## Как это устроено (кратко)

```
┌─────────────────── ПК (Linux) ───────────────────┐        ┌──────── Телефон (Android) ────────┐
│                                                   │        │                                   │
│  opencode #1 (PTY) ┐                              │        │   WebView + xterm.js              │
│  opencode #2 (PTY) ┼─ keeper.js (хранители)       │  WSS   │   • терминал, вкладки, голос      │
│  opencode #3 (PTY) ┘        │                     │◀──────▶│   • foreground-сервис             │
│                             │                     │ TLS +  │   • push-уведомления              │
│  plugin-шим ─┐              ▼                     │ пиннинг│                                   │
│              └──▶ server.js (мост, порт 8890) ────┼────────┤   Обнаружение: mDNS + UDP-маяк    │
│                   node-pty · WebSocket · mDNS     │        │   Вне дома: p2p-туннель (iroh)    │
└───────────────────────────────────────────────────┘        └───────────────────────────────────┘
```

1. Телефон сам находит ПК в сети (mDNS/UDP) и подключается.
2. Ввод/вывод терминала идут в обе стороны по WebSocket поверх TLS.
3. События плагина opencode превращаются в push-уведомления на телефоне.
4. Вне дома обе стороны выходят на relay iroh (исходящие соединения, NAT пробивается автоматически), дальше — прямое p2p или через relay.

---

## Требования

**ПК (мост):**
- Linux (проверено на Arch; ожидаемо работает на большинстве дистрибутивов)
- [Node.js](https://nodejs.org/) 18+
- Установленный и работающий [opencode](https://opencode.ai) (`opencode` в `PATH`)
- *(опционально)* [Rust](https://rustup.rs/) — для сборки p2p-туннеля
- *(опционально)* Python 3.11 + [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) — для голосового ввода
- *(опционально)* Avahi/mDNS — ускоряет обнаружение (есть резервный UDP-маяк)

**Сколько надо VPS:** сам мост ест ~70 МБ RAM. Без голоса хватает **1 ГБ RAM / 1 vCPU** (2 ГБ — с комфортом на 3–5 сессий). С голосовым вводом (`large-v3`) нужно **4 ГБ** (модель ~2.5 ГБ в памяти) либо модель `small` — тогда хватит 2 ГБ. Диск: ~200 МБ без STT-моделей.

**Телефон:**
- Android 8.0+ (API 26)

---

## Установка

### 1. Мост на ПК

```bash
git clone <этот-репозиторий> opencode-bridge
cd opencode-bridge/bridge
npm install
node server.js
```

При первом запуске мост:
- создаст `config.json` из `config.example.json`;
- сгенерирует самоподписанный TLS-сертификат в `bridge/certs/`;
- покажет статус (работает + число подключённых клиентов).

QR и код сопряжения при старте НЕ печатаются — они выдаются только по команде (см. [Сопряжение](#4-сопряжение)).

Дальше отредактируй `bridge/config.json` под себя (см. [Настройка](#настройка)).

> ⚠️ Если на ПК активен файрвол (UFW), открой порты моста, иначе телефон будет видеть адрес, но TCP упрётся в таймаут:
>
> ```bash
> sudo ufw allow 8890/tcp
> sudo ufw allow 8891/udp
> ```

Держать мост удобно в видимом окне терминала:

```bash
bridge/start-foot.sh   # окно foot + лог в bridge/bridge.log, при падении окно не закрывается
```

### 2. Плагин уведомлений (push idle/waiting)

`POST /hook` моста кормит шим-плагин:

```bash
mkdir -p ~/.config/opencode/plugin
cp <репо>/plugin/opencode-bridge.ts ~/.config/opencode/plugin/
# рестарт opencode; переменные OPENCODE_BRIDGE_* прокинет keeper каждой сессии
```

Маппинг событий:

| opencode | мост | Телефон видит |
|---|---|---|
| `session.idle` | `Stop` / idle | «opencode finished responding» |
| `session.status` | `UserPromptSubmit` / working | гасит устаревшие уведомления |
| `permission.asked`, `tui.toast.show` | `Notification` / waiting | «opencode is waiting for approval» |

Таймаут 2 с, ошибки глотаются — плагин никогда не ломает сессию.

### 3. Установка приложения на телефон

Возьми APK из [Releases](../../releases) (`opencode-bridge-*.apk`, подпись debug-ключом, как у оригинала) и установи (разреши установку из неизвестных источников). Либо собери сам — см. [Сборка](#сборка-android-и-туннеля).

### 4. Сопряжение

1. Выполни `bridge/opencode-mobile --qr` в любом терминале ПК — покажет QR-код и короткий код.
2. В приложении нажми **«Добавить компьютер» → «Сканировать QR-код»** и наведи камеру. Вместо QR можно ввести короткий код вручную — тогда приложение попросит сверить отпечаток сертификата (сверяется с данными из ответа моста).
3. Готово: телефон запомнит ПК и будет подключаться сам, когда вы в одной сети.

Код одноразовый, живёт 5 минут: один код — одно устройство, после использования сразу выпускается свежий. Свежий код в любой момент — `opencode-mobile --qr`.

### 5. Доступ вне дома (p2p, без белого IP)

1. Собери туннель (`bridge/bin/opencode-tunnel`, см. [Сборка](#сборка-android-и-туннеля)) — без него `internet.available=false`.
2. Включи флаг **только с самого ПК**: `opencode-mobile --device` → `i` (или `opencode-mobile internet on`). Проверка: `opencode-mobile internet status` — должно быть `ВКЛЮЧЁН` + тикет.
3. Телефон должен **один раз подключиться по LAN уже при включённом флаге** — тогда он заберёт тикет и зарегистрирует свой NodeId в allowlist моста. Без этого шага с улицы не войти.
4. Дальше всё само: дома — напрямую по LAN, на улице — p2p (`direct`, а если NAT строгий — `через relay`). Статус виден в приложении и в `opencode-mobile internet status` (там же RTT пиров).

### 6. systemd-сервис — чтобы мост стартовал сам

```bash
mkdir -p ~/.config/systemd/user
cp <репо>/systemd/opencode-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opencode-bridge
```

Важно: в юните `KillMode=process` — убивает только сам мост, хранители сессий (`keeper.js`) переживают рестарт. Без этого флага systemd убьёт и живые сессии opencode. Логи: `journalctl --user -u opencode-bridge -f`.

> Перед запуском моста в окне терминала останови юнит (`systemctl --user stop`), иначе будет конфликт порта.

---

## Настройка

`bridge/config.json` (создаётся из `config.example.json`):

| Ключ | Назначение |
|------|-----------|
| `port` | Порт моста (по умолчанию `8890`). |
| `host` | Интерфейс прослушивания (`0.0.0.0` — вся LAN). |
| `opencodeCommand` | Команда запуска opencode (обычно `opencode`). |
| `opencodeArgs` | Аргументы по умолчанию. |
| `projects` | **Белый список каталогов**, где телефон может запускать сессии. Пустой список = телефон не может создавать сессии вне `defaultCwd`. |
| `defaultCwd` | Каталог по умолчанию для новых сессий. |
| `env` | Доп. переменные окружения для сессий opencode (например, прокси для API). |
| `scrollbackBytes` | Размер буфера прокрутки терминала. |
| `sttPython` / `sttModel` / `sttLanguage` | Настройки голосового ввода (faster-whisper). |

> ⚠️ `config.json` лежит в `.gitignore`: в нём — **ваши собственные** пути и переменные окружения (у каждого свои), поэтому он не должен попадать в git. Правьте именно `config.json`, а не пример. Туда же никогда не коммитятся `certs/`, `pairings.json`, `internet.json`.

---

## Утилита `opencode-mobile` (на ПК)

Терминальный клиент того же моста — сессии, сопряжение и устройства, всё с сервера:

```
bridge/opencode-mobile                  # новая сессия opencode в текущем каталоге
bridge/opencode-mobile [args…]          # аргументы уходят opencode (run -c, -s, -m…)
bridge/opencode-mobile -l               # список сессий
bridge/opencode-mobile -a [id]          # подключиться к сессии
bridge/opencode-mobile --qr             # показать QR-код сопряжения
bridge/opencode-mobile --device         # доверенные устройства + p2p (интерактивно)
bridge/opencode-mobile devices [--json] # список доверенных (скриптуемо)
bridge/opencode-mobile revoke <id|номер> [-y]  # отозвать устройство
bridge/opencode-mobile internet [on|off|status]  # p2p-доступ через интернет
bridge/opencode-mobile -h               # справка
```

`Ctrl+\` — отсоединиться (сессия продолжает жить). Завершить сессию: выйти из opencode или долгим нажатием на её вкладку в приложении.

Управление устройствами принимает **только локальный клиент** (проверка по UID того же пользователя): с телефона никого отозвать или включить интернет нельзя. Отзыв мгновенный — рвёт живые WS (`4401`) и перезапускает туннель, сбрасывая p2p-соединения отозванного узла.

---

## Сборка Android и туннеля

Исходники портированы: `tunnel/` (`opencode-tunnel`, ALPN `opencode-bridge/1`), Android-пакет `com.q.opencodebridge` (порты `8890/8891`, mDNS `_opencode-bridge._tcp.`, `OPENCODE_BRIDGE?`, `libopencode-tunnel.so`). Основной путь — CI: `.github/workflows/build.yml` собирает `opencode-tunnel` (linux x86_64) и APK (`assembleDebug`, подпись debug-ключом как в релизах оригинала). Артефакты — вкладка Actions → последний зелёный ран → Releases.

Запасной путь — локально (нужны JDK 17 + Android SDK platform-34/build-tools + NDK + Rust с `aarch64-linux-android`):

```bash
cd tunnel && cargo build --release   # -> ../bridge/bin/opencode-tunnel
# Android .so:
rustup target add aarch64-linux-android
export ANDROID_NDK_HOME=$HOME/Android/Sdk/ndk/<версия>
NDK=$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$NDK/aarch64-linux-android26-clang
export CC_aarch64_linux_android=$NDK/aarch64-linux-android26-clang
export AR_aarch64_linux_android=$NDK/llvm-ar
cargo build --release --target aarch64-linux-android
mkdir -p ../android/app/src/main/jniLibs/arm64-v8a
cp target/aarch64-linux-android/release/opencode-tunnel \
   ../android/app/src/main/jniLibs/arm64-v8a/libopencode-tunnel.so
cd ../android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

> Грабли: JDK 17.0.2 падает с cgroup-NPE в контейнере (`validateSigningDebug`) — лечится `org.gradle.jvmargs=-XX:-UseContainerSupport` (уже в `android/gradle.properties`).

---

## Диагностика

| Симптом | Причина и лечение |
|---|---|
| `failed to connect … after 5000ms`, адрес ПК виден | Файрвол на ПК: `sudo ufw allow 8890/tcp && sudo ufw allow 8891/udp`. Либо телефон не в домашней сети (источник `10.x`/`192.0.0.x` вместо `192.168.x`) — вернись на WiFi или включи p2p (раздел 5). |
| `неверный код` / `код истёк` | Код одноразовый, 10 минут, умирает при рестарте моста. Свежий: `opencode-mobile --qr`. |
| `NotFound: FileSystem.access (каталог)` от opencode | Каталога не существует — создай его перед запуском сессии. |
| Мост молча упал, окно закрылось | Смотри хвост `bridge/bridge.log` (при запуске через `start-foot.sh` окно остаётся открытым с кодом выхода). Частая причина — занятый порт (два моста одновременно). |
| Сессия «завершена» сразу после старта | opencode не принял аргументы — текст ошибки в сообщении. Справка: `opencode-mobile -h`. |
| Телефон не находит ПК в сети | Подожди ~12 с (фора на поиск LAN), проверь Multicast/UDP: фаервол, изоляция клиентов (AP isolation) на роутере. |
| Вне дома нет коннекта | Проверь по порядку: `internet status` → `ВКЛЮЧЁН` + тикет; телефон хоть раз цеплялся по LAN после включения флага (тикет + NodeId); смотри пиры: `peers` пусто — телефон не dial'ится (сеть/приложение спало), `relay` — работает через relay, это норма для строгого NAT. |

---

## Проверено

Ручной smoke (2026-10-10): старт на `8890`, `-l`/`--qr`, `create → attach → exit` с очисткой, `POST /hook` → `{"ok":true}`, keeper + PTY переживают `kill`, рестарт → `Восстановлено живых сессий: 1`, `node --check` — всё OK.

Живой тест с планшетом (2026-10-10, вечер):
- Сопряжение по ручному коду: OK; UFW: открыть `8890/tcp` + `8891/udp`.
- p2p из мобильной сети: OK — сначала `direct` (RTT ~6 мс), затем `relay` (~269 мс). Сопрягся раз — работает из любой сети.
- Отзыв устройства с сервера (`revoke`): OK — приложение вылетает на экран сопряжения, allowlist чистится.

---

## Безопасность — не ослаблять

При любом развитии форка: секреты только `0600`, `isLocal` только полный 4-кортеж + `ESTABLISHED` + тот же UID, `/pair` только с основного порта, отзыв рвёт WS `4401` + перезапускает туннель, `KillMode=process` в юните, `config.json` / `pairings.json` / `certs/` никогда в git.

Проект несколько раз проходил аудит безопасности в оригинале; часть найденного исправлена, часть — осознанные компромиссы под конкретную модель угроз (самостоятельный хостинг для себя). Не рассчитывай на него как на многопользовательский сервис.

---

## Структура репозитория

```
opencode-bridge/
├── bridge/               # Мост на ПК (Node.js): server.js, keeper.js, attach.js, web/
│   ├── bin/              # Собранный opencode-tunnel (игнор в git, собирается из tunnel/)
│   ├── certs/            # TLS + iroh-ключи (игнор в git, генерируются при старте)
│   ├── config.example.json
│   ├── start-foot.sh     # Запуск моста в окне foot (с логом, не закрывается при падении)
│   └── opencode-mobile   # CLI-клиент (attach.js)
├── plugin/               # Шим уведомлений для opencode (session.* → POST /hook)
├── tunnel/               # p2p-туннель (Rust, iroh): listen / connect / id
├── android/              # Приложение OpenCode Mobile (com.q.opencodebridge)
├── systemd/              # opencode-bridge.service (user-юнит)
├── .github/workflows/    # CI: tunnel + APK
├── ARCHITECTURE.md       # Архитектура оригинала (подробно, на русском)
├── FORK.md               # Журнал портирования: что менялось и что проверено
└── AUTHORS.md            # Авторы оригинала и форка
```

---

## Вклад в проект

PR и issue приветствуются. Пожалуйста, не коммить личные данные (пути, токены, `config.json`, сертификаты, `pairings.json`) — они уже в `.gitignore`. Иконка приложения — своя (не логотип автора оригинала), авторство оригинала — в [AUTHORS.md](AUTHORS.md), не удалять.

## Лицензия

[GNU General Public License v3.0](LICENSE) — как у оригинала. Оригинал © Black Triangle, разработан в паре с Claude (Anthropic). См. [AUTHORS.md](AUTHORS.md).

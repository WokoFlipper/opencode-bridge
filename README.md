<div align="center">

<img src="assets/hero.jpg" alt="Claude Bridge — управляй Claude Code из любой точки, без серверов" width="820">

# Claude Bridge

**Зеркалируй и управляй своими сессиями [Claude Code](https://claude.com/claude-code) со смартфона.**
Никаких облаков и посредников: телефон общается напрямую с твоим ПК — по локальной сети или через p2p‑туннель, когда ты вне дома.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/ПК-Linux-informational)](#требования)
[![Android](https://img.shields.io/badge/Телефон-Android%208%2B-green)](#android--приложение)

🇷🇺 Русский · [🇬🇧 English](README.en.md)

</div>

---

## Что это

`Claude Bridge` поднимает на твоём компьютере лёгкий мост (Node.js), который «отражает» терминальные сессии Claude Code на Android‑приложение. С телефона ты видишь тот же терминал, что и на ПК, вводишь текст и команды, переключаешь сессии, отвечаешь на запросы разрешений — и получаешь push‑уведомления, когда Claude ждёт ответа или закончил работу.

Всё общение идёт **напрямую между твоими устройствами**. По WiFi это локальная сеть; вне дома — зашифрованный p2p‑туннель (iroh/QUIC) без промежуточных серверов. Трафик защищён TLS с пиннингом сертификата, доступ — по одноразовому сопряжению.

### Ключевые возможности

- 📱 **Полный терминал на телефоне** — xterm.js в WebView: ввод, стрелки, Esc/Tab/Ctrl‑C, прокрутка и выделение пальцем, вставка из буфера.
- 🔀 **Несколько сессий** — вкладки, переключение, запуск новых (`--resume`, `--dangerously-skip-permissions`), несколько сопряжённых ПК.
- 🔔 **Push‑уведомления из hooks** — «Claude ждёт подтверждения», «Claude закончил» с кнопками быстрого ответа прямо из шторки.
- 🌐 **Работа вне дома** — если ПК не виден в WiFi, автоматически поднимается p2p‑туннель (iroh) с приоритетом LAN.
- 🎙️ **Голосовой ввод** — надиктовка сообщений (faster‑whisper на ПК), опционально.
- 🔒 **Приватность и безопасность** — самоподписанный TLS + пиннинг отпечатка, сопряжение по QR/коду, биометрический замок приложения, `FLAG_SECURE`, токены только у доверенных устройств.
- 💾 **Сессии переживают всё** — процессы‑хранители держат PTY независимо от моста: перезапуск моста или закрытие приложения не убивает работу Claude.

> Подробное техническое описание архитектуры — в [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Как это устроено (кратко)

```
┌─────────────────── ПК (Linux) ───────────────────┐        ┌──────── Телефон (Android) ────────┐
│                                                   │        │                                   │
│  Claude Code #1 (PTY) ┐                           │        │   WebView + xterm.js              │
│  Claude Code #2 (PTY) ┼─ keeper.js (хранители)    │  WSS   │   • терминал, вкладки, голос      │
│  Claude Code #3 (PTY) ┘        │                  │◀──────▶│   • foreground‑сервис             │
│                                │                  │ TLS +  │   • push‑уведомления              │
│  hooks ─┐                      ▼                  │ пиннинг│                                   │
│         └──▶ server.js (мост, порт 8790) ─────────┼────────┤   Обнаружение: mDNS + UDP‑маяк    │
│              node‑pty · WebSocket · mDNS          │        │   Вне дома: p2p‑туннель (iroh)    │
└───────────────────────────────────────────────────┘        └───────────────────────────────────┘
```

1. Телефон сам находит ПК в сети (mDNS/UDP) и подключается.
2. Ввод/вывод терминала идут в обе стороны по WebSocket поверх TLS.
3. Hooks Claude Code превращаются в push‑уведомления на телефоне.

---

## Требования

**ПК (мост):**
- Linux (проверено на Debian; ожидаемо работает на большинстве дистрибутивов)
- [Node.js](https://nodejs.org/) 18+
- Установленный и работающий [Claude Code](https://claude.com/claude-code) (`claude` в `PATH`)
- *(опционально)* [Rust](https://rustup.rs/) — для сборки p2p‑туннеля
- *(опционально)* Python 3.11 + [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) — для голосового ввода
- *(опционально)* Avahi/mDNS — ускоряет обнаружение (есть резервный UDP‑маяк)

**Телефон:**
- Android 8.0+ (API 26)

---

## Установка

### 1. Мост на ПК

```bash
git clone https://github.com/HelpFreedom/claude-bridge.git
cd claude-bridge/bridge
npm install
npm start
```

При первом запуске мост:
- создаст `config.json` из `config.example.json`;
- сгенерирует самоподписанный TLS‑сертификат в `bridge/certs/`;
- напечатает **QR‑код и код сопряжения** для телефона.

Дальше отредактируй `bridge/config.json` под себя (см. [Настройка](#настройка)) и, при желании, установи как systemd‑сервис (см. ниже).

#### (Опционально) p2p‑туннель для доступа вне дома

Туннель — отдельный бинарник на Rust. Собери его и положи рядом с мостом:

```bash
cd tunnel
cargo build --release
mkdir -p ../bridge/bin
cp target/release/claude-tunnel ../bridge/bin/claude-tunnel
```

Включается позже из приложения (в меню ПК → «разрешить через интернет») или командой `claude-mobile --device` → `i`.

#### (Опционально) systemd‑сервис — чтобы мост стартовал сам

Создай `~/.config/systemd/user/claude-bridge.service`:

```ini
[Unit]
Description=Claude Bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/claude-bridge/bridge
ExecStart=/usr/bin/node %h/claude-bridge/bridge/server.js
Restart=on-failure
RestartSec=3
# Убивать только сам мост: хранители сессий должны переживать рестарт
KillMode=process
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-bridge
```

> `%h` — домашний каталог. Поправь путь, если склонировал в другое место.

### 2. Android‑приложение

Проще всего — **скачать готовый APK** из [Releases](https://github.com/HelpFreedom/claude-bridge/releases) и установить (нужно разрешить установку из неизвестных источников). APK подписан отладочным ключом.

Либо собрать самому:

```bash
cd android
./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

Для работы p2p‑туннеля на телефоне нужна нативная библиотека `libclaudetunnel.so` (aarch64) — см. [Сборка туннеля под Android](#сборка-туннеля-под-android). Без неё всё, кроме доступа вне дома, работает.

### 3. Сопряжение

1. Запусти мост на ПК — он покажет QR‑код (или выполни `claude-mobile --qr`).
2. В приложении нажми **«Добавить компьютер» → «Сканировать QR‑код»** и наведи камеру.
3. Готово: телефон запомнит ПК и будет подключаться сам, когда вы в одной сети.

Вместо QR можно ввести короткий код вручную — тогда приложение попросит сверить отпечаток сертификата (для защиты от подмены рекомендуется всё же QR).

---

## Настройка

`bridge/config.json` (создаётся из `config.example.json`):

| Ключ | Назначение |
|------|-----------|
| `port` | Порт моста (по умолчанию `8790`). |
| `host` | Интерфейс прослушивания (`0.0.0.0` — вся LAN). |
| `claudeCommand` | Команда запуска Claude Code (обычно `claude`). |
| `projects` | **Белый список каталогов**, где телефон может запускать сессии. Пустой список = телефон не может создавать сессии вне `defaultCwd`. |
| `defaultCwd` | Каталог по умолчанию для новых сессий. |
| `env` | Доп. переменные окружения для сессий (например, прокси для API). |
| `scrollbackBytes` | Размер буфера прокрутки терминала. |
| `sttPython` / `sttModel` / `sttLanguage` | Настройки голосового ввода (faster‑whisper). |

> ⚠️ `config.json` в `.gitignore` — он содержит ваши личные пути и переменные окружения и **не должен попадать в git**.

### Голосовой ввод (опционально)

```bash
python3 -m pip install faster-whisper
```

Укажи в `config.json` интерпретатор (`sttPython`), модель (`sttModel`, напр. `large-v3`) и язык (`sttLanguage`). Модель загрузится в память при первом использовании.

---

## Утилита `claude-mobile` (на ПК)

Терминальный клиент того же моста — удобно управлять сессиями и устройствами с самого ПК:

```
claude-mobile              # новая сессия в текущем каталоге
claude-mobile [args…]      # аргументы уходят claude (--resume, --continue…)
claude-mobile -l           # список сессий
claude-mobile -a [id]      # подключиться к сессии
claude-mobile --device     # доверенные устройства + p2p‑доступ (просмотр/отзыв)
claude-mobile --qr         # показать QR‑код сопряжения
claude-mobile -h           # справка
```

`Ctrl+\` — отсоединиться (сессия продолжает жить). Завершить сессию: выйти из Claude (двойной `Ctrl+C` или `/exit`) или долгим нажатием на её вкладку в приложении.

---

## Сборка туннеля под Android

Нативная библиотека собирается кросс‑компиляцией под aarch64 через Android NDK:

```bash
rustup target add aarch64-linux-android
export ANDROID_NDK_HOME=$HOME/Android/Sdk/ndk/<версия>
NDK=$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$NDK/aarch64-linux-android26-clang
export CC_aarch64_linux_android=$NDK/aarch64-linux-android26-clang
export AR_aarch64_linux_android=$NDK/llvm-ar

cd tunnel
cargo build --release --target aarch64-linux-android
mkdir -p ../android/app/src/main/jniLibs/arm64-v8a
cp target/aarch64-linux-android/release/claude-tunnel \
   ../android/app/src/main/jniLibs/arm64-v8a/libclaudetunnel.so
```

Затем пересобери APK (`./gradlew assembleDebug`).

---

## Безопасность

- **TLS + пиннинг отпечатка**: телефон доверяет только конкретному сертификату вашего ПК; отпечаток же служит идентификатором ПК.
- **Сопряжение**: одноразовый код (40 бит) с глобальным лимитом попыток; QR‑путь пиннит отпечаток до передачи секретов.
- **Токены доступа** выдаются только сопряжённым устройствам; отзыв — мгновенный (рвёт живые соединения).
- **Локальный доступ** (`claude-mobile`, hooks) доверяется по UID того же пользователя, а не «любому на loopback».
- **На телефоне**: биометрический замок, `FLAG_SECURE` (нет превью и скриншотов), токен не покидает нативную часть.

Проект несколько раз проходил аудит безопасности; часть найденного исправлена, часть — осознанные компромиссы под конкретную модель угроз (самостоятельный хостинг для себя). Не рассчитывай на него как на многопользовательский сервис.

---

## Вклад в проект

PR и issue приветствуются. Пожалуйста, не коммить личные данные (пути, токены, `config.json`, сертификаты) — они уже в `.gitignore`.

## Лицензия

[GNU General Public License v3.0](LICENSE) © Black Triangle.
Разработано в паре с Claude (Anthropic).

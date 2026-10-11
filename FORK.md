# OpenCode Bridge — форк Claude Bridge под opencode

Форк [`HelpFreedom/claude-bridge`](https://github.com/HelpFreedom/claude-bridge)
(см. `ARCHITECTURE.md` оригинала), пересобранный под TUI-сессии `opencode`.
Алгоритм связи и принципы безопасности автора сохранены 1:1 — менялись только
имена, порты и точки интеграции с агентом (подробности ниже).

Лицензия: GPLv3 (как у оригинала). Статус: v1 — мост на ПК без Android-части.

## Чем отличается от оригинала

| Было (`claude-bridge`) | Стало (`opencode-bridge`) |
|---|---|
| Порты `8790` HTTPS/WSS, `8791` UDP, `8792` туннель | `8890` / `8891` / `8892` — оба моста живут рядом |
| `~/.claude-bridge/sessions/` | `~/.opencode-bridge/sessions/` |
| `CLAUDE_BRIDGE_SESSION` / `CLAUDE_BRIDGE_PORT` / `CLAUDE_BRIDGE_URL` | `OPENCODE_BRIDGE_SESSION` / `OPENCODE_BRIDGE_PORT` / `OPENCODE_BRIDGE_URL` (старые имена читаются как fallback) |
| `config: claudeCommand/claudeArgs` | `config: opencodeCommand/opencodeArgs` (старые ключи — fallback) |
| CLI `claude-mobile`, бинарь по умолчанию `claude` | `bridge/opencode-mobile`, бинарь `opencode` |
| Новая сессия из Web UI: `--resume`, `--dangerously-skip-permissions` | `--continue`, `--fork` (форк требует continue — ставится автоматически) |
| Хуки Claude Code (`UserPromptSubmit/PostToolUse/Notification/Stop` из `settings.json`) | Плагин-шим `plugin/opencode-bridge.ts` (события `session.idle/session.status/permission.asked/tui.toast.show` → тот же `POST /hook`) |
| `bridge-hook.sh` на `$CLAUDE_BRIDGE_*` | Тот же скрипт, на `$OPENCODE_BRIDGE_*` (старые переменные — fallback) |
| mDNS-сервис `claude-bridge`, UDP-магия `CLAUDE_BRIDGE?`, QR `{cb:1,…}` | `opencode-bridge`, `OPENCODE_BRIDGE?`, `{ob:1,…}` (маяк отвечает и старым клиентам ключом `claudeBridge`) |
| CN сертификата `claude-bridge` | `opencode-bridge` (сертификат генерируется заново при первом старте — телефон сопрягается заново) |

Без изменений: TLS-пиннинг, pairing-код 10 мин/одноразовый/throttle,
`isLocal` по UID (fail-closed), права `0600/0700`, keeper-протокол и переживание
рестарта, WS-протокол, scrollback, rate-limits, xterm UI, `stt.py`, CSP-заголовки.

## Установка (v1, мост на ПК)

```bash
cd ~/projects/opencode-bridge/bridge
npm install
# при первом старте создастся config.json из config.example.json
node server.js
```

Отредактируй `bridge/config.json`: `defaultCwd`, `projects` (белый список
каталогов для удалённого создания сессий), при желании `env` (прокси).

CLI:

```bash
bridge/opencode-mobile            # новая сессия opencode в текущем каталоге
bridge/opencode-mobile -l         # список
bridge/opencode-mobile -a [id]    # подключиться (Ctrl+\ — отсоединиться)
bridge/opencode-mobile --qr       # QR/код сопряжения
bridge/opencode-mobile --device   # устройства + p2p-доступ (интерактивное TUI)
bridge/opencode-mobile devices [--json]       # список доверенных (скриптуемо)
bridge/opencode-mobile revoke <id|номер> [-y] # отозвать устройство
bridge/opencode-mobile internet [on|off|status]  # p2p-доступ через интернет
```

Всё управление устройствами — только с этого ПК: мост принимает
`devices`/`revokeDevice`/`setInternet` исключительно от локального клиента
(проверка `isLocal` по UID, как у автора). Телефон отозвать никого не может.

systemd (файл в `systemd/opencode-bridge.service`):

```bash
mkdir -p ~/.config/systemd/user
cp ~/projects/opencode-bridge/systemd/opencode-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opencode-bridge
```

## Плагин уведомлений (push idle/waiting)

`POST /hook` моста оставлен без изменений — его кормит новый шим:

```bash
mkdir -p ~/.config/opencode/plugin
cp ~/projects/opencode-bridge/plugin/opencode-bridge.ts ~/.config/opencode/plugin/
# рестарт opencode; переменные OPENCODE_BRIDGE_* прокинет keeper каждой сессии
```

Маппинг: `session.idle → Stop/idle` («завершил ответ»),
`session.status → UserPromptSubmit/working` (гасит устаревшие уведомления),
`permission.asked` / `tui.toast.show → Notification/waiting` («ждёт подтверждения»).
Таймаут 2 с, ошибки глотаются — хук никогда не ломает сессию (fail-safe наружу,
fail-closed внутрь — как у автора).

## Проверено (2026-10-10, ручной smoke)

- Старт на `8890`, QR с новым брендингом: OK
- `opencode-mobile -l`, `--qr`: OK
- `create → attach → exit` локального клиента, очистка meta/sock: OK
- `POST /hook` → `{"ok":true}`, `bridge-hook.sh` exit 0: OK
- Убийство моста (`kill <pid>`): keeper + PTY живы (`keeper.js` + `/bin/sleep` в `ps`)
- Рестарт: `Восстановлено живых сессий: 1`, сессия в `-l` жива: OK
- `node --check` на `server/keeper/attach`: OK

## Живой тест с телефоном (2026-10-10, вечер)

- Файрвол: на ПК активен UFW — открыли `8890/tcp` + `8891/udp`.
  Без этого телефон видел адрес моста, но TCP упирался в таймаут 5 с.
- Сопряжение по ручному коду: OK (`LENOVO TB321FU`, `nodeId` зарегистрирован —
  p2p-allowlist заполнен).
- Код одноразовый, TTL 10 мин; свежий — `opencode-mobile --qr` в любом терминале
  (окно моста показывает код только от своего старта).
- Мост держим в видимом `foot -T opencode-bridge` (фоновые запуски из агента
  нестабильны — шелл-сессия их прибивает). systemd-юнит
  (`systemd/opencode-bridge.service`, установлен в `~/.config/systemd/user/`)
  проверен (`active`, слушает `8890`), но для отладки с QR на глазах держим
  окно; перед запуском окна юнит стопаем (`systemctl --user stop`), иначе
  конфликт порта.
- Дальше: зеркало живой сессии opencode + уведомления через
  `plugin/opencode-bridge.ts`.

## v2 — Android + туннель (исходники портированы 2026-10-10, сборка ждёт тулчейн)

Готово на уровне кода:

- `tunnel/`: `opencode-tunnel`, `ALPN opencode-bridge/1` (`Cargo.toml`, `main.rs`, `Cargo.lock`).
  `bridge/server.js` ищет `bridge/bin/opencode-tunnel`.
- Android: пакет `com.q.opencodebridge` (manifest, gradle, все 5 `.java`, каталог
  переименован), порты `8890/8891`, mDNS `_opencode-bridge._tcp.`,
  `OPENCODE_BRIDGE?`, `libopencode-tunnel.so`, строки и диалоги (`opencode-mobile`,
  `--continue/--fork`), `assets/web/` пересинканы из `bridge/web/`.
- Обратная совместимость приёма: QR `{ob:1}` + legacy `{cb:1}`, UDP-ключ
  `opencodeBridge` + legacy `claudeBridge`. Передача — только новые имена.
- Безопасность не тронута: пиннинг, nonce-прокси, `INTERNAL_PERM` (переименован
  синхронно в manifest и коде), `FLAG_SECURE`/biolock, канал уведомлений
  `opencode_events`.

Осталось — собрать. Основной путь — GitHub Actions
(`.github/workflows/build.yml`): на каждый push/PR собираются
`opencode-tunnel` (linux x86_64) и APK (`assembleDebug`, подпись debug-ключом
как в релизах оригинала) с `libopencode-tunnel.so` внутри. Забирать артефакты —
вкладка Actions → последний зелёный ран → Artifacts.
Запуск CI — обычный `git push` (нужен аппрув владельца по гейту «да»).

Статус 2026-10-11: сборка исправлена, CI зелёный — `opencode-tunnel`
(linux x86_64, ~3 МБ) и APK 0.1.1 (`versionCode 2`, ~5 МБ,
`com.q.opencodebridge`, внутри `lib/arm64-v8a/libopencode-tunnel.so` +
`assets/web`) собираются на каждый push и лежат в Artifacts. По пути
вылечены три ошибки workflow: кавычки в `packages` setup-android,
`ANDROID_NDK_HOME` мимо реального SDK-рута, actions v4 → v5.

Статус 2026-10-10: собрано локально без CI — `bridge/bin/opencode-tunnel`
(x86_64, 7.1 МБ, `--help` OK) и APK 6.4 МБ (`com.q.opencodebridge`, minSdk 26,
внутри `lib/arm64-v8a/libopencode-tunnel.so` + `assets/web`). Тулчейн:
Java 17.0.2 (mise), SDK platform-34/build-tools, NDK r26d, Rust 1.99 +
`aarch64-linux-android`. Грабли: JDK 17.0.2 падает с cgroup-NPE в контейнере
(`validateSigningDebug`) — лечится `org.gradle.jvmargs=-XX:-UseContainerSupport`
(уже в `android/gradle.properties`).

Запасной путь — локально (нужны JDK 17 + Android SDK platform-34/build-tools + NDK
+ Rust с `aarch64-linux-android`):

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
```

## Доступ вне дома (p2p, проверено 2026-10-10)

1. `bridge/bin/opencode-tunnel` собран (локально; в CI — артефакт).
2. Включить флаг может только локальный клиент: `opencode-mobile --device` → `i`
   (или WS `setInternet:true`). Проверка: WS `internet` → `enabled:true`,
   `available:true`, есть `ticket`/`nodeId`; процесс
   `opencode-tunnel listen --target 127.0.0.1:8892` жив.
3. Телефон должен ОДИН раз подключиться по LAN уже при включённом флаге —
   тогда он заберёт `nodeTicket` и зарегистрирует свой NodeId
   (`registerNode` → `certs/tunnel-allow.txt`). Без этого шага с улицы не войти:
   тикет негде взять, узла нет в allowlist.
4. Дальше телефон сам уходит на туннель вне WiFi (приоритет LAN сохраняется:
   дома — напрямую, на улице — p2p direct/relay).
5. Дубликаты устройств в `pairings.json` (переустановки приложения плодят
   записи) безвредны, чистятся через `opencode-mobile --device` (отзыв).

## Безопасность — не ослаблять

При любом развитии форка: секреты только `0600`, `isLocal` только полный
4-кортеж + `ESTABLISHED` + тот же UID, `/pair` только с основного порта,
отзыв рвёт WS `4401` + перезапускает туннель, `KillMode=process` в юните,
`config.json/pairings.json/certs/` никогда в git.

## 2026-10-11/12 — сервер полностью на EN + APK 1.3/1.4

Сервер (bridge/plugin/web/tunnel, CLI): все строки и комменты на EN.
Сопряжение: TTL 5 минут, код одноразовый с авторасширением — после успешного
сопряжения сразу выпускается свежий; QR и код при старте не печатаются,
только по `opencode-mobile --qr`. В окне моста — статус + счётчик клиентов
с опознанием (`имя (сессия …/service)`).

Приложение 1.3: ZXing QR-сканер (без Play Services), запрос снятия
оптимизации батареи + статус/кнопка в настройках.
Приложение 1.4: один APK, переключатель RU/EN в настройках (`Lang` таблицы,
дефолт — локаль системы, каналы уведомлений пересоздаются). Уведомления
от сервера и web-терминал — всегда EN.

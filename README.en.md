<div align="center">

# OpenCode Bridge

**Mirror and control your [opencode](https://opencode.ai) sessions from your phone.**
No cloud, no middlemen: the phone talks directly to your PC — over your LAN, or through a p2p tunnel when you're away.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/PC-Linux-informational)](#requirements)
[![Android](https://img.shields.io/badge/Phone-Android%208%2B-green)](#installing-the-app-on-the-phone)

[🇷🇺 Русский](README.md) · 🇬🇧 English

</div>

---

## What it is

`OpenCode Bridge` is a fork of [`HelpFreedom/claude-bridge`](https://github.com/HelpFreedom/claude-bridge), rebuilt for `opencode` TUI sessions. A lightweight Node.js bridge on your computer mirrors opencode terminal sessions to the "OpenCode Mobile" Android app. From your phone you see the same terminal as on the PC, type text and commands, switch sessions, answer permission prompts — and get push notifications when opencode is waiting for you or has finished.

All communication is **direct between your own devices**. On WiFi it's your LAN; away from home it's an encrypted p2p tunnel (iroh/QUIC) with no relay servers in between and no public IP needed. Traffic is protected by TLS with certificate pinning; access is granted via one-time pairing: pair once — connect from any network.

The original connection algorithm and the author's security principles are preserved 1:1 — only names, ports, and agent integration points changed.

### Features

- 📱 **Full terminal on the phone** — xterm.js in a WebView: input, arrows, Esc/Tab/Ctrl-C, touch scroll & selection, clipboard paste.
- 🔀 **Multiple sessions** — tabs, switching, new sessions (`--continue`, `--fork`), multiple paired PCs.
- 🔔 **Push notifications from the plugin** — "opencode is waiting", "opencode finished" with quick-reply buttons from the notification shade.
- 🌐 **Works away from home** — if the PC isn't visible on WiFi, a p2p tunnel (iroh) is brought up automatically, LAN always preferred.
- 🎙️ **Voice input** — dictate messages (faster-whisper on the PC), optional.
- 🔒 **Privacy & security** — self-signed TLS + fingerprint pinning, QR/code pairing, biometric app lock, `FLAG_SECURE`, tokens only on trusted devices.
- 💾 **Sessions survive everything** — keeper processes own the PTYs independently of the bridge: restarting the bridge or closing the app doesn't kill opencode's work.
- 🖥️ **Server-side client management** — trusted-device list, instant revoke, and p2p toggle, all from the PC CLI. The phone cannot revoke anyone.

> The deep technical description of the original architecture lives in [ARCHITECTURE.md](ARCHITECTURE.md) (in Russian). What the fork changed — in [FORK.md](FORK.md).

---

## How it differs from the original

| Was (`claude-bridge`) | Became (`opencode-bridge`) |
|---|---|
| Ports `8790` HTTPS/WSS, `8791` UDP, `8792` tunnel | `8890` / `8891` / `8892` — both bridges can run side by side |
| `~/.claude-bridge/sessions/` | `~/.opencode-bridge/sessions/` |
| `CLAUDE_BRIDGE_SESSION` / `CLAUDE_BRIDGE_PORT` / `CLAUDE_BRIDGE_URL` | `OPENCODE_BRIDGE_SESSION` / `OPENCODE_BRIDGE_PORT` / `OPENCODE_BRIDGE_URL` (old names read as fallback) |
| `config: claudeCommand/claudeArgs` | `config: opencodeCommand/opencodeArgs` (old keys — fallback) |
| CLI `claude-mobile`, default binary `claude` | `bridge/opencode-mobile`, binary `opencode` |
| New session from Web UI: `--resume`, `--dangerously-skip-permissions` | `--continue`, `--fork` |
| Claude Code hooks (`settings.json`) | Shim plugin `plugin/opencode-bridge.ts` (`session.idle` / `session.status` / `permission.asked` / `tui.toast.show` → same `POST /hook`) |
| `bridge-hook.sh` on `$CLAUDE_BRIDGE_*` | Same script on `$OPENCODE_BRIDGE_*` (old vars — fallback) |
| mDNS service `claude-bridge`, UDP magic `CLAUDE_BRIDGE?`, QR `{cb:1,…}` | `opencode-bridge`, `OPENCODE_BRIDGE?`, `{ob:1,…}` (receiving side also understands old names) |
| Certificate CN `claude-bridge` | `opencode-bridge` (certificate is generated fresh — pair the phone again) |
| "Claude Bridge" app with the author's logo | "OpenCode Mobile" app with its own icon (violet glow, yellow antenna) |

Unchanged: TLS pinning, pairing code (10 min, one-time, throttled), UID-based `isLocal` (fail-closed), `0600/0700` permissions, keeper protocol with restart survival, WS protocol, scrollback, rate limits, xterm UI, `stt.py`, CSP headers. Device management (`devices`/`revoke`/`setInternet`) is accepted **only from the local PC client**, exactly like the original.

---

## How it works (short)

```
┌─────────────────── PC (Linux) ───────────────────┐        ┌──────── Phone (Android) ────────┐
│                                                   │        │                                 │
│  opencode #1 (PTY) ┐                              │        │   WebView + xterm.js            │
│  opencode #2 (PTY) ┼─ keeper.js (keepers)        │  WSS   │   • terminal, tabs, voice       │
│  opencode #3 (PTY) ┘        │                     │◀──────▶│   • foreground service          │
│                             │                     │ TLS +  │   • push notifications          │
│  plugin shim ─┐             ▼                     │ pinning│                                 │
│               └──▶ server.js (bridge, port 8890) ─┼────────┤   Discovery: mDNS + UDP beacon  │
│                    node-pty · WebSocket · mDNS    │        │   Away: p2p tunnel (iroh)       │
└───────────────────────────────────────────────────┘        └─────────────────────────────────┘
```

1. The phone discovers the PC on the network (mDNS/UDP) and connects.
2. Terminal I/O flows both ways over a WebSocket on top of TLS.
3. opencode plugin events turn into push notifications on the phone.
4. Away from home both sides dial out to an iroh relay (outbound connections traverse NAT automatically), then go direct p2p or relayed.

---

## Requirements

**PC (bridge):**
- Linux (verified on Arch; expected to work on most distros)
- [Node.js](https://nodejs.org/) 18+
- A working [opencode](https://opencode.ai) install (`opencode` on `PATH`)
- *(optional)* [Rust](https://rustup.rs/) — to build the p2p tunnel
- *(optional)* Python 3.11 + [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) — for voice input
- *(optional)* Avahi/mDNS — speeds up discovery (there's a UDP beacon fallback)

**How much VPS:** the bridge itself uses ~70 MB RAM. Without voice, **1 GB RAM / 1 vCPU** is enough (2 GB comfortably holds 3–5 sessions). With voice input (`large-v3`) you need **4 GB** (~2.5 GB for the model) or the `small` model — then 2 GB is enough. Disk: ~200 MB without STT models.

**Phone:**
- Android 8.0+ (API 26)

---

## Installation

### 1. Bridge on the PC

```bash
git clone <this-repo> opencode-bridge
cd opencode-bridge/bridge
npm install
node server.js
```

On first start the bridge:
- creates `config.json` from `config.example.json`;
- generates a self-signed TLS certificate in `bridge/certs/`;
- prints a **QR code and pairing code** for the phone.

Then edit `bridge/config.json` (see [Configuration](#configuration)).

> ⚠️ If the PC runs a firewall (UFW), open the bridge ports, otherwise the phone sees the address but TCP hits a timeout:
>
> ```bash
> sudo ufw allow 8890/tcp
> sudo ufw allow 8891/udp
> ```

To keep the bridge in a visible terminal window with logging (the window stays open on crash):

```bash
bridge/start-foot.sh   # foot window + log in bridge/bridge.log
```

### 2. Notification plugin (push idle/waiting)

```bash
mkdir -p ~/.config/opencode/plugin
cp <repo>/plugin/opencode-bridge.ts ~/.config/opencode/plugin/
# restart opencode; the keeper injects OPENCODE_BRIDGE_* into every session
```

Event mapping:

| opencode | bridge | Phone sees |
|---|---|---|
| `session.idle` | `Stop` / idle | "finished answering" |
| `session.status` | `UserPromptSubmit` / working | clears stale notifications |
| `permission.asked`, `tui.toast.show` | `Notification` / waiting | "waiting for approval" |

2 s timeout, errors swallowed — the plugin never breaks a session.

### 3. Installing the app on the phone

Grab the APK from [Releases](../../releases) (`opencode-bridge-*.apk`, debug-signed like the original releases) and install it (allow installs from unknown sources). Or build it yourself — see [Building](#building-android-and-tunnel).

### 4. Pairing

1. Start the bridge on the PC — it shows a QR code (or run `bridge/opencode-mobile --qr` in any terminal).
2. In the app tap **"Add computer" → "Scan QR code"** and point the camera. Instead of QR you can type the short code manually — the app will then ask you to verify the certificate fingerprint against the one shown in the PC terminal.
3. Done: the phone remembers the PC and reconnects automatically on the same network.

The code is one-time with a 10-minute TTL — this is the author's deliberate design (a glimpsed code dies with the process; restarts can't stretch the brute-force window). A fresh code anytime — `opencode-mobile --qr`.

### 5. Access away from home (p2p, no public IP)

1. Build the tunnel (`bridge/bin/opencode-tunnel`, see [Building](#building-android-and-tunnel)) — without it `internet.available=false`.
2. Enable the flag **from the PC only**: `opencode-mobile --device` → `i` (or `opencode-mobile internet on`). Check: `opencode-mobile internet status` should say enabled plus a ticket.
3. The phone must **connect once over LAN after the flag is enabled** — it then fetches the ticket and registers its NodeId in the bridge allowlist. Without this step there's no way in from outside.
4. After that it's automatic: home — direct LAN, away — p2p (`direct`, or `relay` behind strict NAT). Status is visible in the app and in `opencode-mobile internet status` (peer RTT included).

### 6. systemd service — autostart the bridge

```bash
mkdir -p ~/.config/systemd/user
cp <repo>/systemd/opencode-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opencode-bridge
```

Note `KillMode=process` in the unit — only the bridge itself is killed, session keepers (`keeper.js`) survive a restart. Without it systemd would kill live opencode sessions too. Logs: `journalctl --user -u opencode-bridge -f`.

> Stop the unit before running the bridge in a terminal window (`systemctl --user stop`), or the port will conflict.

---

## Configuration

`bridge/config.json` (created from `config.example.json`):

| Key | Purpose |
|-----|---------|
| `port` | Bridge port (default `8890`). |
| `host` | Listen interface (`0.0.0.0` — whole LAN). |
| `opencodeCommand` | opencode launch command (usually `opencode`). |
| `opencodeArgs` | Default args. |
| `projects` | **Allow-list of directories** where the phone may start sessions. Empty = phone can't create sessions outside `defaultCwd`. |
| `defaultCwd` | Default directory for new sessions. |
| `env` | Extra env for opencode sessions (e.g. API proxy). |
| `scrollbackBytes` | Terminal scrollback buffer size. |
| `sttPython` / `sttModel` / `sttLanguage` | Voice input settings (faster-whisper). |

> ⚠️ `config.json` is in `.gitignore`: it holds **your own** paths and env (everyone's differ), so it must never land in git. Same for `certs/`, `pairings.json`, `internet.json`.

---

## `opencode-mobile` CLI and server-side client management

The same bridge terminal client — sessions, pairing, and devices, all from the server side:

```
bridge/opencode-mobile                  # new opencode session in cwd
bridge/opencode-mobile [args…]          # args go to opencode (run -c, -s, -m…)
bridge/opencode-mobile -l               # list sessions
bridge/opencode-mobile -a [id]          # attach to a session
bridge/opencode-mobile --qr             # show pairing QR
bridge/opencode-mobile --device         # trusted devices + p2p (interactive)
bridge/opencode-mobile devices [--json] # list trusted devices (scriptable)
bridge/opencode-mobile revoke <id|number> [-y]  # revoke a device
bridge/opencode-mobile internet [on|off|status]  # p2p internet access
bridge/opencode-mobile -h               # help
```

`Ctrl+\` — detach (the session keeps living). End a session by exiting opencode or long-pressing its tab in the app.

Device management is accepted **only from the local client** (same-user UID check, exactly as the original): the phone can neither revoke anyone nor toggle internet access. Revoke is instant — it tears down live sockets (`4401`) and restarts the tunnel, dropping the revoked node's p2p connections.

---

## Building Android and tunnel

Sources are ported: `tunnel/` (`opencode-tunnel`, ALPN `opencode-bridge/1`), Android package `com.q.opencodebridge` (ports `8890/8891`, mDNS `_opencode-bridge._tcp.`, `OPENCODE_BRIDGE?`, `libopencode-tunnel.so`). The primary path is CI: `.github/workflows/build.yml` builds `opencode-tunnel` (linux x86_64) and the APK (`assembleDebug`, debug-signed like the original releases). Artifacts — Actions tab → latest green run → Releases.

Local fallback (needs JDK 17 + Android SDK platform-34/build-tools + NDK + Rust with `aarch64-linux-android`):

```bash
cd tunnel && cargo build --release   # -> ../bridge/bin/opencode-tunnel
# Android .so:
rustup target add aarch64-linux-android
export ANDROID_NDK_HOME=$HOME/Android/Sdk/ndk/<version>
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

> Gotcha: JDK 17.0.2 crashes with a cgroup NPE in containers (`validateSigningDebug`) — fixed by `org.gradle.jvmargs=-XX:-UseContainerSupport` (already in `android/gradle.properties`).

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `failed to connect … after 5000ms`, PC address visible | Firewall on the PC: `sudo ufw allow 8890/tcp && sudo ufw allow 8891/udp`. Or the phone isn't on home WiFi (source `10.x`/carrier instead of `192.168.x`) — rejoin WiFi or enable p2p (step 5). |
| `wrong code` / `code expired` | Code is one-time, 10-minute TTL, dies on bridge restart — by design. Fresh one: `opencode-mobile --qr`. |
| `NotFound: FileSystem.access (directory)` from opencode | The directory doesn't exist — create it before starting the session. |
| Bridge died silently, window closed | See tail of `bridge/bridge.log` (when started via `start-foot.sh` the window stays open with the exit code). Usual suspect — port already taken (two bridges at once). |
| Session "finished" right after start | opencode rejected the args — the reason is in the message. Help: `opencode-mobile -h`. |
| Phone doesn't discover the PC | Wait ~12 s (LAN search grace), check multicast/UDP: firewall, client isolation (AP isolation) on the router. |
| No connection away from home | In order: `internet status` → enabled + ticket; phone connected over LAN at least once after enabling (ticket + NodeId); look at peers: empty — phone isn't dialing (network/app asleep), `relay` — working via relay, normal for strict NAT. |

---

## Verified

Manual smoke (2026-10-10): start on `8890`, `-l`/`--qr`, `create → attach → exit` with cleanup, `POST /hook` → `{"ok":true}`, keeper + PTY survive `kill`, restart → `1 live session restored`, `node --check` — all OK.

Live tablet test (2026-10-10, evening):
- Manual-code pairing: OK; UFW: open `8890/tcp` + `8891/udp`.
- p2p from mobile data: OK — first `direct` (RTT ~6 ms), then `relay` (~269 ms). Pair once — works from any network.
- Server-side revoke (`revoke`): OK — app drops to the pairing screen, allowlist cleaned.

---

## Security — do not weaken

Secrets only `0600`, `isLocal` only full 4-tuple + `ESTABLISHED` + same UID, `/pair` only on the main port, revoke tears down WS `4401` + restarts the tunnel, `KillMode=process` in the unit, `config.json` / `pairings.json` / `certs/` never in git.

The original went through several security audits; some findings fixed, some are conscious trade-offs for a self-hosted single-user threat model. Don't treat it as a multi-user service.

---

## Repository layout

```
opencode-bridge/
├── bridge/               # PC bridge (Node.js): server.js, keeper.js, attach.js, web/
│   ├── bin/              # Built opencode-tunnel (git-ignored, built from tunnel/)
│   ├── certs/            # TLS + iroh keys (git-ignored, generated at startup)
│   ├── config.example.json
│   ├── start-foot.sh     # Run the bridge in a foot window (logged, stays open on crash)
│   └── opencode-mobile   # CLI client (attach.js)
├── plugin/               # opencode notification shim (session.* → POST /hook)
├── tunnel/               # p2p tunnel (Rust, iroh): listen / connect / id
├── android/              # OpenCode Mobile app (com.q.opencodebridge)
├── systemd/              # opencode-bridge.service (user unit)
├── .github/workflows/    # CI: tunnel + APK
├── ARCHITECTURE.md       # Original architecture (detailed, Russian)
├── FORK.md               # Porting log: what changed, what was verified
└── AUTHORS.md            # Original + fork authors
```

---

## Contributing

PRs and issues welcome. Please don't commit personal data (paths, tokens, `config.json`, certificates, `pairings.json`) — they're already in `.gitignore`. The app icon is our own (not the original author's logo); keep the original attribution in [AUTHORS.md](AUTHORS.md), don't remove it.

## License

[GNU General Public License v3.0](LICENSE) — same as the original. Original © Black Triangle, pair-built with Claude (Anthropic). See [AUTHORS.md](AUTHORS.md).

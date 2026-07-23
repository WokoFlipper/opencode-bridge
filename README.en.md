<div align="center">

<img src="assets/hero.jpg" alt="Claude Bridge — control Claude Code from anywhere, no servers" width="820">

# Claude Bridge

**Mirror and control your [Claude Code](https://claude.com/claude-code) sessions from your phone.**
No cloud, no middlemen: the phone talks directly to your PC — over your LAN, or through a p2p tunnel when you're away.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/PC-Linux-informational)](#requirements)
[![Android](https://img.shields.io/badge/Phone-Android%208%2B-green)](#2-android-app)

[🇷🇺 Русский](README.md) · 🇬🇧 English

</div>

---

## What it is

`Claude Bridge` runs a lightweight Node.js bridge on your computer that mirrors Claude Code terminal sessions to an Android app. From your phone you see the same terminal as on the PC, type text and commands, switch sessions, answer permission prompts — and get push notifications when Claude is waiting for you or has finished.

All communication is **direct between your own devices**. On WiFi it's your LAN; away from home it's an encrypted p2p tunnel (iroh/QUIC) with no relay servers in between. Traffic is protected by TLS with certificate pinning; access is granted via one-time pairing.

### Features

- 📱 **Full terminal on the phone** — xterm.js in a WebView: input, arrows, Esc/Tab/Ctrl-C, touch scroll & selection, clipboard paste.
- 🔀 **Multiple sessions** — tabs, switching, new sessions (`--resume`, `--dangerously-skip-permissions`), multiple paired PCs.
- 🔔 **Push notifications from hooks** — "Claude is waiting", "Claude finished", with quick-reply buttons from the notification shade.
- 🌐 **Works away from home** — if the PC isn't visible on WiFi, a p2p tunnel (iroh) is brought up automatically, LAN always preferred.
- 🎙️ **Voice input** — dictate messages (faster-whisper on the PC), optional.
- 🔒 **Privacy & security** — self-signed TLS + fingerprint pinning, QR/code pairing, biometric app lock, `FLAG_SECURE`, tokens only on trusted devices.
- 💾 **Sessions survive everything** — keeper processes own the PTYs independently of the bridge: restarting the bridge or closing the app doesn't kill Claude's work.

> A deep technical description of the architecture lives in [ARCHITECTURE.md](ARCHITECTURE.md) (in Russian).

---

## How it works (short)

1. The phone discovers the PC on the network (mDNS/UDP) and connects.
2. Terminal I/O flows both ways over a WebSocket on top of TLS.
3. Claude Code hooks turn into push notifications on the phone.

---

## Requirements

**PC (bridge):**
- Linux (tested on Debian; expected to work on most distros)
- [Node.js](https://nodejs.org/) 18+
- A working [Claude Code](https://claude.com/claude-code) install (`claude` on `PATH`)
- *(optional)* [Rust](https://rustup.rs/) — to build the p2p tunnel
- *(optional)* Python 3.11 + [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) — for voice input
- *(optional)* Avahi/mDNS — speeds up discovery (there's a UDP beacon fallback)

**Phone:**
- Android 8.0+ (API 26)

---

## Installation

### 1. Bridge on the PC

```bash
git clone https://github.com/HelpFreedom/claude-bridge.git
cd claude-bridge/bridge
npm install
npm start
```

On first run the bridge:
- creates `config.json` from `config.example.json`;
- generates a self-signed TLS certificate in `bridge/certs/`;
- prints a **QR code and pairing code** for the phone.

Then edit `bridge/config.json` (see [Configuration](#configuration)) and optionally install it as a systemd service (below).

#### (Optional) p2p tunnel for access away from home

The tunnel is a separate Rust binary. Build it and place it next to the bridge:

```bash
cd tunnel
cargo build --release
mkdir -p ../bridge/bin
cp target/release/claude-tunnel ../bridge/bin/claude-tunnel
```

Enable it later from the app (PC menu → "allow over internet") or via `claude-mobile --device` → `i`.

#### (Optional) systemd service

Create `~/.config/systemd/user/claude-bridge.service`:

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
# Kill only the bridge itself: session keepers must survive a restart
KillMode=process
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-bridge
```

### 2. Android app

Easiest: **download the prebuilt APK** from [Releases](https://github.com/HelpFreedom/claude-bridge/releases) and install it (allow installs from unknown sources). The APK is debug-signed.

Or build it yourself:

```bash
cd android
./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

For the p2p tunnel on the phone you also need the native `libclaudetunnel.so` (aarch64) — see [Building the tunnel for Android](#building-the-tunnel-for-android). Everything except away-from-home access works without it.

### 3. Pairing

1. Start the bridge on the PC — it shows a QR code (or run `claude-mobile --qr`).
2. In the app tap **"Add computer" → "Scan QR code"** and point the camera.
3. Done: the phone remembers the PC and reconnects on its own when you're on the same network.

You can also type a short code manually — the app will then ask you to verify the certificate fingerprint (QR is recommended to prevent tampering).

---

## Configuration

`bridge/config.json` (created from `config.example.json`):

| Key | Meaning |
|-----|---------|
| `port` | Bridge port (default `8790`). |
| `host` | Listen interface (`0.0.0.0` = whole LAN). |
| `claudeCommand` | Command to launch Claude Code (usually `claude`). |
| `projects` | **Allow-list of directories** where the phone may start sessions. Empty = the phone can't create sessions outside `defaultCwd`. |
| `defaultCwd` | Default directory for new sessions. |
| `env` | Extra environment variables for Claude Code sessions (e.g. an API proxy — see below). |
| `scrollbackBytes` | Terminal scrollback buffer size. |
| `sttPython` / `sttModel` / `sttLanguage` | Voice input settings (faster-whisper). |

> ⚠️ `config.json` is in `.gitignore`: it holds **your own** paths and environment (different for everyone), so it must not be committed. Edit `config.json` (created from `config.example.json` on first run), not the example.

### Proxy for Claude Code (optional)

If `claude` must reach the Anthropic API through a proxy, put it in `env` — the bridge passes these variables to every session it launches:

```json
"env": {
  "HTTP_PROXY":  "http://127.0.0.1:8118",
  "HTTPS_PROXY": "http://127.0.0.1:10808",
  "http_proxy":  "http://127.0.0.1:8118",
  "https_proxy": "http://127.0.0.1:10808",
  "NO_PROXY":    "127.0.0.1,localhost,192.168.0.0/16",
  "no_proxy":    "127.0.0.1,localhost,192.168.0.0/16"
}
```

Use your own proxy addresses. `NO_PROXY` keeps localhost and the local network unproxied (so the bridge↔phone link stays direct). Alternatively, export these variables in the bridge's own environment (shell or `systemd` unit): the bridge inherits them and passes them on. An explicit `env` entry is more robust.

### Voice input (optional)

```bash
python3 -m pip install faster-whisper
```

Set the interpreter (`sttPython`), model (`sttModel`, e.g. `large-v3`) and language (`sttLanguage`) in `config.json`.

---

## The `claude-mobile` CLI (on the PC)

A terminal client for the same bridge — handy for managing sessions and devices from the PC itself:

```
claude-mobile              # new session in the current directory
claude-mobile [args…]      # args are passed to claude (--resume, --continue…)
claude-mobile -l           # list sessions
claude-mobile -a [id]      # attach to a session
claude-mobile --device     # trusted devices + p2p access (view/revoke)
claude-mobile --qr         # show the pairing QR code
claude-mobile -h           # help
```

`Ctrl+\` detaches (the session keeps running). To end a session: exit Claude (double `Ctrl+C` or `/exit`) or long-press its tab in the app.

---

## Building the tunnel for Android

The native library is cross-compiled for aarch64 via the Android NDK:

```bash
rustup target add aarch64-linux-android
export ANDROID_NDK_HOME=$HOME/Android/Sdk/ndk/<version>
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

Then rebuild the APK (`./gradlew assembleDebug`).

---

## Security

- **TLS + fingerprint pinning**: the phone trusts only your PC's specific certificate; the fingerprint also serves as the PC's identity.
- **Pairing**: a one-time 40-bit code with a global attempt limit; the QR path pins the fingerprint before any secret is sent.
- **Access tokens** are issued only to paired devices; revocation is immediate (drops live connections).
- **Local access** (`claude-mobile`, hooks) is trusted by same-user UID, not "anyone on loopback".
- **On the phone**: biometric lock, `FLAG_SECURE` (no previews/screenshots), the token never leaves the native layer.

This project has been through several security reviews; some findings were fixed, others are deliberate trade-offs for its threat model (self-hosting for yourself). Don't treat it as a multi-tenant service.

---

## Contributing

PRs and issues welcome. Please don't commit personal data (paths, tokens, `config.json`, certificates) — they're already in `.gitignore`.

## License

[GNU General Public License v3.0](LICENSE) © Black Triangle.
Built in pair with Claude (Anthropic).

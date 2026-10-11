#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { Bonjour } = require('bonjour-service');

const CONFIG_PATH = path.join(__dirname, 'config.json');
// First run: no personal config.json yet — create it from the example.
// config.json is in .gitignore, so personal paths/proxy never land in git.
if (!fs.existsSync(CONFIG_PATH)) {
  fs.copyFileSync(path.join(__dirname, 'config.example.json'), CONFIG_PATH);
  console.log('  Created config.json from config.example.json — edit it as needed');
}
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
// config.json.env lands wholesale in the environment of session child
// processes — if a secret ends up there (e.g. an API key), it must not be
// visible to other users of the machine. Keep the file 0600.
try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
const WEB_DIR = path.join(__dirname, 'web');
const VENDOR = {
  '/vendor/xterm.js': require.resolve('@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm.css': require.resolve('@xterm/xterm/css/xterm.css'),
  '/vendor/addon-fit.js': require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
};
// Security headers for static content: CSP as an HTTP header (frame-ancestors
// in <meta> is ignored), plus clickjacking and MIME-sniffing protection.
const SEC_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:*; " +
    "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------- tls + auth

// Self-signed certificate: generated once, the phone pins its fingerprint.
const CERT_DIR = path.join(__dirname, 'certs');
if (!fs.existsSync(path.join(CERT_DIR, 'cert.pem'))) {
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${CERT_DIR}/key.pem" ` +
    `-out "${CERT_DIR}/cert.pem" -days 3650 -nodes -subj "/CN=opencode-bridge" 2>/dev/null`
  );
}
// The private TLS key and the key directory must not be visible to other
// users of the machine (openssl under umask 022 creates key.pem as 0644):
// harden the directory to 0700 and key.pem to 0600 (cert.pem is public, 0644 ok).
try { fs.chmodSync(CERT_DIR, 0o700); } catch {}
try { fs.chmodSync(path.join(CERT_DIR, 'key.pem'), 0o600); } catch {}
const TLS = {
  key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
  cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')),
};
function pemToDer(pem) {
  const b64 = pem.toString().replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}
const FINGERPRINT = crypto.createHash('sha256').update(pemToDer(TLS.cert)).digest('hex');

// Trusted devices. The pairing code is fresh on every launch.
const PAIR_FILE = path.join(__dirname, 'pairings.json');
let pairings = { devices: [] };
try { pairings = JSON.parse(fs.readFileSync(PAIR_FILE, 'utf8')); } catch { /* first run */ }
// pairings.json holds device tokens in plaintext — owner-only file
// (0600). Harden permissions on an existing file too (could be 0644).
try { if (fs.existsSync(PAIR_FILE)) fs.chmodSync(PAIR_FILE, 0o600); } catch {}
// The pairing code lives 5 minutes (fresh one — at start or via opencode-mobile --qr).
// One-time and does NOT survive restart — by author design: a guessed code
// dies with the process, the brute-force window can't stretch past a restart.
// Anti-bruteforce: 5 wrong attempts -> /pair block for 15 minutes.
const PAIR_TTL_MS = 5 * 60 * 1000;
let pairState = { code: '', expiresAt: 0 };
// Code-bruteforce lockout — PER SOURCE (by IP), not global: otherwise 5
// wrong attempts from one address would block pairing for everyone.
const pairGuard = new Map(); // ip -> { fails, blockedUntil }
// Global (all addresses) counter of wrong attempts for the CURRENT code.
// Closes the per-IP-throttle bypass via many sources (incl. 127.x from a
// different-UID process): guessing from fresh addresses still hits the common cap.
// Reset only when a new code is generated (F11/F14).
let pairFailTotal = 0;
const PAIR_FAIL_TOTAL_MAX = 50;
// Foot-window status: running line + live client count.
function clientDesc(ws) {
  const name = ws.deviceId === 'local' ? 'local PC'
    : (pairings.devices.find((d) => d.id === ws.deviceId) || {}).name
      || ws.deviceId || '?';
  const role = ws.attached ? `session ${ws.attached}` : 'service';
  return `${name} (${role})`;
}
function printStatus() {
  console.log('');
  console.log('  OpenCode Bridge running (HTTPS/WSS, port ' + CONFIG.port + ')');
  console.log(`  Connected clients: ${allClients.size}`);
  for (const ws of allClients) console.log(`    - ${clientDesc(ws)}`);
  console.log('');
}
function regenPairCode() {
  pairFailTotal = 0;
  pairState = {
    // 5 bytes = 40 bits of entropy (was 24): together with the total attempt cap
    // makes brute force within the 5-minute window infeasible (F14)
    code: crypto.randomBytes(5).toString('hex').toUpperCase(),
    expiresAt: Date.now() + PAIR_TTL_MS,
  };
  return pairState;
}
regenPairCode();

// Public device id — token hash: referenceable without exposing the token
function deviceIdOf(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}
for (const d of pairings.devices) if (!d.id) d.id = deviceIdOf(d.token);

function savePairings() {
  // 0600: device tokens must not be readable by other users of the machine
  fs.writeFileSync(PAIR_FILE, JSON.stringify(pairings, null, 2), { mode: 0o600 });
  try { fs.chmodSync(PAIR_FILE, 0o600); } catch {}
}

// UID of the bridge owner process. We trust as "local" only connections from
// the same user — never any loopback process (otherwise a different UID / a
// sandboxed service could gain 'local' rights and run arbitrary commands).
const SELF_UID = typeof process.getuid === 'function' ? process.getuid() : -1;

// "0100007F" (kernel byte order, little-endian) -> "127.0.0.1"
function procIpv4(hex) {
  if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
  return [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)]
    .map((h) => parseInt(h, 16)).join('.');
}
// normalize the socket address to IPv4 form (strip v4-mapped ::ffff: prefix)
function norm4(ip) {
  if (!ip) return null;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
}
/**
 * UID of the process at the other end of a loopback connection (Linux, /proc/net/tcp).
 * We compare the FULL 4-tuple (both IPs and both ports) and require the
 * ESTABLISHED (01) state. Matching on ports alone would be ambiguous: a
 * different-UID process could open 127.0.0.1:E -> 127.0.0.2:PORT (the server
 * listens on 0.0.0.0) with the same ephemeral port E as the owner's connection
 * to 127.0.0.1:PORT, and slip in a foreign UID from the first matching row.
 * Full address comparison isolates exactly our socket; ESTABLISHED cuts off
 * TIME_WAIT ghosts.
 * Returns -1 when it cannot be determined (isLocal then goes fail-closed).
 */
function peerUid(socket) {
  try {
    const rip = norm4(socket.remoteAddress); // client's local address = our remote
    const lip = norm4(socket.localAddress);  // client's destination = our local
    const rport = socket.remotePort, lport = socket.localPort;
    // IPv4 only (server listens on 0.0.0.0); IPv6 bind would need /proc/net/tcp6
    if (!rip || !lip || !(rport > 0) || !(lport > 0)) return -1;
    let data;
    try { data = fs.readFileSync('/proc/net/tcp', 'utf8'); } catch { return -1; }
    const lines = data.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].trim().split(/\s+/);
      if (p.length < 8 || p[3] !== '01') continue; // ESTABLISHED only
      const lc = p[1].split(':'), rc = p[2].split(':');
      if (procIpv4(lc[0]) === rip && parseInt(lc[1], 16) === rport &&
          procIpv4(rc[0]) === lip && parseInt(rc[1], 16) === lport) {
        const uid = parseInt(p[7], 10);
        if (Number.isInteger(uid)) return uid;
      }
    }
  } catch {}
  return -1;
}

function isLocal(req) {
  const a = req.socket.remoteAddress;
  const loopback = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  // tunnel traffic also arrives from loopback, but on a separate port:
  // local trust — main port only (opencode-mobile, hooks)
  if (!loopback || req.socket.localPort !== CONFIG.port) return false;
  // UID indeterminable (non-POSIX / container / hardened /proc) -> NO trust:
  // fail-closed, better to break a local client than to let a stranger in
  if (SELF_UID < 0) return false;
  return peerUid(req.socket) === SELF_UID; // same-user processes only
}
function requestToken(req, url) {
  const q = url.searchParams.get('token');
  if (q) return q;
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)bridgeToken=([a-f0-9]+)/);
  return m ? m[1] : null;
}
// Constant-time secret comparison (timing-attack protection for token/code).
function safeEqStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
/** Find a device by token in constant time (no early '===' leak). */
function deviceByToken(t) {
  if (!t) return null;
  for (const d of pairings.devices) if (safeEqStr(d.token, t)) return d;
  return null;
}
function authed(req, url) {
  if (isLocal(req)) return true; // this PC is always trusted
  return !!deviceByToken(requestToken(req, url));
}
/** Revoke a device and immediately tear down its connections. */
function revokeDeviceById(id) {
  const idx = pairings.devices.findIndex((d) => d.id === id);
  if (idx < 0) return false;
  const name = pairings.devices[idx].name;
  pairings.devices.splice(idx, 1);
  savePairings();
  writeAllowFile(); // revoked NodeId leaves the tunnel allowlist
  console.log(`\n  Device revoked: ${name}`);
  for (const c of allClients) {
    if (c.deviceId === id) { try { c.close(4401, 'revoked'); } catch { } }
  }
  // A live iroh connection of a revoked node doesn't drop on its own (the
  // allowlist is checked at setup): restart the tunnel to reset all p2p
  // connections — legitimate devices reconnect immediately under the new
  // allowlist. Plus the sidecar re-checks the allowlist on every new stream.
  if (tunnel && inet.enabled) { stopTunnel(); startTunnel(); }
  return true;
}

// ---------------------------------------------------------------- sessions
// Each session lives in a separate keeper process (keeper.js) and talks
// to the bridge over a unix socket: restarting the bridge doesn't kill opencode.

const SESS_DIR = path.join(os.homedir(), '.opencode-bridge', 'sessions');
fs.mkdirSync(SESS_DIR, { recursive: true, mode: 0o700 });
// mkdir with mode is umask-sensitive, and mode doesn't change on an existing
// dir: keeper sockets are the only protection against same-user hijack of a
// foreign session, so harden to 0700 (owner access only).
try { fs.chmodSync(SESS_DIR, 0o700); } catch {}

const sessions = new Map(); // id -> session
let seq = 0;

// Resource-exhaustion guard: cap on live sessions and their creation rate
// (each session is a separate keeper process + PTY child).
const MAX_SESSIONS = CONFIG.maxSessions || 24;
const createTimes = new Map(); // deviceId -> [timestamps]
function rateAllowCreate(deviceId) {
  const now = Date.now();
  const key = deviceId || 'anon';
  const arr = (createTimes.get(key) || []).filter((t) => now - t < 60000);
  createTimes.set(key, arr);
  if (arr.length >= 10) return false; // at most 10 session creations per minute
  arr.push(now);
  return true;
}

function makeSession(meta) {
  return {
    id: meta.id,
    title: meta.title,
    cwd: meta.cwd,
    command: meta.cmd,
    pid: null,
    createdAt: meta.createdAt,
    sock: null,
    buffer: [],
    bufferBytes: 0,
    clients: new Set(),
    alive: true,
    lastNotify: null,
    status: 'idle', // idle | working | waiting — by hooks
    cols: meta.cols,
    rows: meta.rows,
    lastInput: null, // last client to type — we keep their size
  };
}

function keeperSend(session, obj) {
  if (session.sock) { try { session.sock.write(JSON.stringify(obj) + '\n'); } catch {} }
}

function dropSession(session, exitCode) {
  if (!sessions.has(session.id)) return;
  session.alive = false;
  broadcast({ type: 'exit', id: session.id, exitCode: exitCode == null ? -1 : exitCode });
  sessions.delete(session.id);
  broadcastSessions();
}

function connectKeeper(session, retries) {
  const sockPath = path.join(SESS_DIR, session.id + '.sock');
  const sock = net.connect(sockPath);
  let acc = '';
  sock.on('connect', () => { session.sock = sock; });
  sock.on('data', (chunk) => {
    acc += chunk.toString('utf8');
    let i;
    while ((i = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, i);
      acc = acc.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.t === 'hello') {
        session.pid = m.pid;
        session.cols = m.cols;
        session.rows = m.rows;
        session.buffer = [m.buffer];
        session.bufferBytes = Buffer.byteLength(m.buffer);
        // The creating client attaches EARLIER than the bridge dials the
        // keeper (created goes out immediately, hello — after retries). Everything
        // opencode drew before hello (e.g. a new-directory trust prompt)
        // exists only in this buffer — re-send it, otherwise the client
        // faces an empty screen until the first keypress.
        if (m.buffer) {
          const shot = JSON.stringify({
            type: 'scrollback', id: session.id, data: m.buffer,
            alive: session.alive, cols: session.cols, rows: session.rows,
          });
          for (const ws of session.clients) if (ws.readyState === 1) ws.send(shot);
        }
        broadcastSessions();
      } else if (m.t === 'out') {
        session.buffer.push(m.d);
        session.bufferBytes += Buffer.byteLength(m.d);
        while (session.bufferBytes > (CONFIG.scrollbackBytes || 262144) && session.buffer.length > 1) {
          session.bufferBytes -= Buffer.byteLength(session.buffer.shift());
        }
        const msg = JSON.stringify({ type: 'output', id: session.id, data: m.d });
        for (const ws of session.clients) if (ws.readyState === 1) ws.send(msg);
      } else if (m.t === 'exit') {
        dropSession(session, m.code);
      }
    }
  });
  sock.on('error', () => {
    if (!session.sock && retries > 0) {
      setTimeout(() => connectKeeper(session, retries - 1), 300);
    } else if (!session.sock) {
      // Keeper unreachable: either never came up or died dirty (crash,
      // PC reboot) without cleaning its files. Remove them ourselves — otherwise
      // the bridge would "restore" a zombie session on every start and lose it
      // right away. Live keepers never land here: their socket answers.
      try { fs.unlinkSync(path.join(SESS_DIR, session.id + '.json')); } catch {}
      try { fs.unlinkSync(path.join(SESS_DIR, session.id + '.sock')); } catch {}
      console.log(`  Session ${session.id}: keeper not responding — files removed`);
      dropSession(session, -1);
    }
  });
  sock.on('close', () => {
    if (session.sock === sock) { session.sock = null; dropSession(session, -1); }
  });
}

// A remote (phone) session's working directory must sit inside the allowed
// projects — otherwise the phone could launch opencode anywhere on the FS.
// Local clients (opencode-mobile) are unrestricted.
function isUnderAllowedRoot(dir) {
  const resolved = path.resolve(dir);
  return (CONFIG.projects || []).some((r) => {
    const rr = path.resolve(r);
    return resolved === rr || resolved.startsWith(rr + path.sep);
  });
}
function remoteCwd(cwd) {
  const fallback = CONFIG.defaultCwd || os.homedir();
  if (!cwd) return fallback;
  // realpath resolves symlinks: otherwise a link INSIDE an allowed project
  // (e.g. /home/user/projects/link -> /etc) would pass the lexical check and
  // opencode would start outside the projects. Nonexistent path -> fallback.
  let real;
  try { real = fs.realpathSync(cwd); } catch { return fallback; }
  return isUnderAllowedRoot(real) ? real : fallback;
}

function createSession({ cwd, command, args, title, local }) {
  const id = 's' + (++seq) + '-' + crypto.randomBytes(3).toString('hex');
  // Only local clients pick an arbitrary COMMAND (binary)
  // (opencode-mobile, desktop browser): the phone always launches the configured
  // opencode — no /bin/sh and the like from the phone.
  // Arguments (e.g. --resume, --dangerously-skip-permissions) are the phone's
  // own — these are its stock launch options, and a paired device already has
  // full interactive control over the PTY, so limiting them is pointless.
  // But we DO limit the phone's DIRECTORY to the allowed projects, so opencode
  // can't start outside them (e.g. in ~/.ssh).
  const cmd = (local && command) ? command : (CONFIG.opencodeCommand || CONFIG.claudeCommand || 'opencode');
  const cmdArgs = (args && args.length) ? args : (CONFIG.opencodeArgs || CONFIG.claudeArgs || []);
  const dir = local ? (cwd || CONFIG.defaultCwd || os.homedir()) : remoteCwd(cwd);

  const meta = {
    id,
    cmd,
    args: cmdArgs,
    cwd: dir,
    title: title || `${path.basename(dir)} · ${cmd}`,
    createdAt: Date.now(),
    cols: 100,
    rows: 30,
    scrollbackBytes: CONFIG.scrollbackBytes || 262144,
  };
  // Never write env into the meta file: process.env may hold secrets while the
  // file stays on disk. Pass the environment to the keeper via the process itself.
  const childEnv = { ...process.env, ...CONFIG.env, OPENCODE_BRIDGE_SESSION: id, FORCE_COLOR: '3' };
  const metaPath = path.join(SESS_DIR, id + '.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  const child = spawn(process.execPath, [path.join(__dirname, 'keeper.js'), metaPath], {
    detached: true,
    stdio: 'ignore',
    env: childEnv,
  });
  child.unref();

  const session = makeSession(meta);
  sessions.set(id, session);
  connectKeeper(session, 20);
  broadcastSessions();
  return session;
}

// Restoring live sessions after a bridge restart
function restoreSessions() {
  let restored = 0;
  for (const f of fs.readdirSync(SESS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const metaPath = path.join(SESS_DIR, f);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (!fs.existsSync(metaPath.replace(/\.json$/, '.sock'))) {
        fs.unlinkSync(metaPath); // keeper died with the session
        continue;
      }
      const n = parseInt(String(meta.id).slice(1), 10);
      if (n > seq) seq = n;
      const session = makeSession(meta);
      sessions.set(meta.id, session);
      connectKeeper(session, 3);
      restored++;
    } catch { /* corrupt meta file — skip */ }
  }
  if (restored) console.log(`  Restored live sessions: ${restored}`);
}

// PTY size policy: "size follows whoever types".
// A watching connection doesn't change the size.
function resizePty(session, cols, rows) {
  if (!session.alive || !(cols > 0) || !(rows > 0)) return;
  if (session.cols === cols && session.rows === rows) return;
  keeperSend(session, { t: 'resize', cols, rows });
  session.cols = cols;
  session.rows = rows;
  const msg = JSON.stringify({ type: 'resized', id: session.id, cols, rows });
  for (const ws of session.clients) if (ws.readyState === 1) ws.send(msg);
}

function sessionList() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    pid: s.pid,
    alive: s.alive,
    status: s.status,
    createdAt: s.createdAt,
    lastNotify: s.lastNotify,
  }));
}

// ---------------------------------------------------------------- stt
// A long-lived python worker with faster-whisper: the model loads once.

let sttProc = null;
let sttQueue = [];

function ensureStt() {
  if (sttProc) return;
  sttProc = spawn(CONFIG.sttPython || 'python3.11', [path.join(__dirname, 'stt.py')], {
    env: {
      ...process.env,
      STT_MODEL: CONFIG.sttModel || 'large-v3',
      ...(CONFIG.sttPrompt ? { STT_PROMPT: CONFIG.sttPrompt } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let acc = '';
  sttProc.stdout.on('data', (d) => {
    acc += d.toString('utf8');
    let i;
    while ((i = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, i);
      acc = acc.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.ready) { console.log('  STT model loaded'); continue; }
      const job = sttQueue.shift();
      if (job) (m.error ? job.reject(new Error(m.error)) : job.resolve(m.text || ''));
    }
  });
  sttProc.stderr.on('data', (d) => process.stderr.write('[stt] ' + d));
  sttProc.on('exit', () => {
    sttProc = null;
    for (const j of sttQueue) j.reject(new Error('STT worker exited'));
    sttQueue = [];
  });
}

function transcribe(file) {
  ensureStt();
  return new Promise((resolve, reject) => {
    sttQueue.push({ resolve, reject });
    sttProc.stdin.write(JSON.stringify({ file, language: CONFIG.sttLanguage || 'ru' }) + '\n');
  });
}

// ---------------------------------------------------------------- internet (p2p iroh)
// Optional internet access: the opencode-tunnel sidecar (Rust + iroh)
// accepts p2p connections and forwards them to the local tunnel port.
// Enabled only explicitly: opencode-mobile --device -> “i”.

const INET_FILE = path.join(__dirname, 'internet.json');
const TUNNEL_BIN = path.join(__dirname, 'bin', 'opencode-tunnel');
const TUNNEL_PORT = CONFIG.port + 2; // local port for tunnel traffic
// allowlist of iroh nodes: the phone registers its NodeId (over LAN, via a
// protected WS); ids of all paired devices land here. The tunnel re-reads the
// file on every connection and admits known nodes only.
const ALLOW_FILE = path.join(CERT_DIR, 'tunnel-allow.txt');

function writeAllowFile() {
  const ids = pairings.devices
    .map((d) => (d.nodeId || '').trim().toLowerCase())
    .filter((x) => /^[0-9a-f]{64}$/.test(x));
  try { fs.writeFileSync(ALLOW_FILE, ids.join('\n') + (ids.length ? '\n' : ''), { mode: 0o600 }); } catch {}
}

let inet = { enabled: false };
try { inet = { ...inet, ...JSON.parse(fs.readFileSync(INET_FILE, 'utf8')) }; } catch { /* default */ }

let tunnel = null; // opencode-tunnel process
let tunnelInfo = { ticket: null, nodeId: null };
const tunnelPeers = new Map(); // connection id -> { remote, path, addr, rttMs }
let tunnelRestartTimer = null;

function internetMsg() {
  return {
    type: 'internet',
    enabled: inet.enabled,
    available: fs.existsSync(TUNNEL_BIN),
    ticket: tunnelInfo.ticket,
    nodeId: tunnelInfo.nodeId,
    peers: [...tunnelPeers.values()],
  };
}
function broadcastInternet() { broadcast(internetMsg()); }

function startTunnel() {
  if (tunnel || !inet.enabled) return;
  if (!fs.existsSync(TUNNEL_BIN)) {
    console.error('  Internet access enabled, but bridge/bin/opencode-tunnel is not built');
    return;
  }
  // orphan tunnels from past runs (same key/NodeId) — remove without
  // a shell: the install path must not be interpreted as a command
  try { spawnSync('pkill', ['-f', TUNNEL_BIN + ' listen']); } catch { /* no rights/no processes */ }
  writeAllowFile(); // current allowlist as of tunnel start
  const child = spawn(TUNNEL_BIN, [
    'listen',
    '--target', '127.0.0.1:' + TUNNEL_PORT,
    '--secret-file', path.join(CERT_DIR, 'iroh.key'),
    '--allow-file', ALLOW_FILE,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnel = child;
  let acc = '';
  child.stdout.on('data', (d) => {
    acc += d.toString('utf8');
    let i;
    while ((i = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, i);
      acc = acc.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.event === 'ready') {
        tunnelInfo = { ticket: m.ticket, nodeId: m.node_id };
        console.log('  Internet access (iroh) active, node: ' + (m.node_id || '').slice(0, 12) + '…');
      } else if (m.event === 'conn') {
        tunnelPeers.set(m.id, { remote: m.remote, path: null, addr: null, rttMs: null });
      } else if (m.event === 'path') {
        const peer = tunnelPeers.get(m.id) || {};
        tunnelPeers.set(m.id, { ...peer, path: m.path, addr: m.addr, rttMs: m.rtt_ms });
      } else if (m.event === 'close') {
        tunnelPeers.delete(m.id);
      }
      broadcastInternet();
    }
  });
  child.stderr.on('data', () => { /* sidecar debug output not needed in bridge log */ });
  child.on('exit', () => {
    if (tunnel !== child) return;
    tunnel = null;
    tunnelInfo = { ticket: null, nodeId: null };
    tunnelPeers.clear();
    broadcastInternet();
    if (inet.enabled) tunnelRestartTimer = setTimeout(startTunnel, 3000);
  });
}

function stopTunnel() {
  clearTimeout(tunnelRestartTimer);
  if (tunnel) { try { tunnel.kill(); } catch { } tunnel = null; }
  tunnelInfo = { ticket: null, nodeId: null };
  tunnelPeers.clear();
  broadcastInternet();
}

function setInternet(enabled) {
  inet.enabled = !!enabled;
  fs.writeFileSync(INET_FILE, JSON.stringify(inet, null, 2));
  console.log('\n  Internet access: ' + (inet.enabled ? 'ON' : 'off'));
  if (inet.enabled) startTunnel(); else stopTunnel();
}

// ---------------------------------------------------------------- http

function httpHandler(req, res) {
  const url = new URL(req.url, 'http://x');

  // Pairing a new device: one-time code -> permanent token
  if (req.method === 'POST' && url.pathname === '/pair') {
    // main port only (LAN/local): the tunnel comes up only AFTER
    // pairing, and letting internet peers hit /pair (and stuff
    // everyone's brute-force lockout) is pointless
    if (req.socket.localPort !== CONFIG.port) { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch {}
      const ip = req.socket.remoteAddress || 'unknown';
      // Map-growth backstop: delete ONLY addresses with no active block —
      // otherwise an attacker would reset their own block by inflating the map (F11).
      if (pairGuard.size > 4096) {
        const now = Date.now();
        for (const [k, v] of pairGuard) if (v.blockedUntil < now) pairGuard.delete(k);
      }
      // Total cap on wrong attempts for the current code (guessing from many
      // addresses dead-ends here; reset only by a new code) (F11/F14).
      if (pairFailTotal >= PAIR_FAIL_TOTAL_MAX) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end('{"error":"too many wrong attempts — refresh the code: opencode-mobile --qr"}');
        return;
      }
      const g = pairGuard.get(ip) || { fails: 0, blockedUntil: 0 };
      if (Date.now() < g.blockedUntil) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end('{"error":"too many attempts — pairing from this address is blocked for 15 minutes"}');
        return;
      }
      if (Date.now() > pairState.expiresAt) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"error":"code expired — run opencode-mobile --qr on the PC"}');
        return;
      }
      if (!safeEqStr((p.code || '').toUpperCase(), pairState.code)) {
        g.fails++;
        pairFailTotal++; // total counter for the current code (F11)
        if (g.fails >= 5) {
          g.blockedUntil = Date.now() + 15 * 60 * 1000;
          g.fails = 0;
          console.log('\n  Pairing with ' + ip + ' blocked for 15 minutes (code brute force)');
        }
        pairGuard.set(ip, g);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"error":"wrong pairing code"}');
        return;
      }
      pairGuard.delete(ip);
      // The code is one-time: burn it immediately so one glimpsed code can't
      // pair several devices (or re-pair after revoke) within the 5 minutes.
      // Check-and-burn is a synchronous block with no await: two parallel
      // requests physically can't both pass, the second always sees an expired code.
      // Issue a fresh code right away so no dead code lingers in the terminal
      // (QR for it — opencode-mobile --qr).
      pairState.expiresAt = 0;
      regenPairCode();
      console.log(`\n  Previous code used — new pairing code issued (5 minutes).`);
      const token = crypto.randomBytes(24).toString('hex');
      // The device name comes from the client: strip control characters
      // (ANSI/escape), otherwise they'd land in the operator console (output
      // spoofing, screen clearing) and in the phone UI (F13). One value — for
      // storage and log alike.
      const safeName = (String(p.name || '')
        .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
        .slice(0, 64)) || 'device';
      pairings.devices.push({
        id: deviceIdOf(token),
        token,
        name: safeName,
        addedAt: new Date().toISOString(),
      });
      savePairings();
      console.log(`\n  Paired new device: ${safeName}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        token, fingerprint: FINGERPRINT, port: CONFIG.port, hostname: os.hostname(),
        nodeTicket: tunnelInfo.ticket, internet: inet.enabled,
      }));
    });
    return;
  }

  // Recognizing dictated audio (the phone sends m4a, we answer with text)
  if (req.method === 'POST' && url.pathname === '/stt') {
    if (!authed(req, url)) { res.writeHead(401); res.end(); return; }
    // Queue cap: one worker processes recordings one by one — don't let
    // an authorized client fill memory/queue with an upload stream.
    if (sttQueue.length >= (CONFIG.sttMaxQueue || 4)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"error":"recognition queue full, try again later"}');
      return;
    }
    const tmp = path.join(os.tmpdir(), 'cb-stt-' + crypto.randomBytes(6).toString('hex') + '.m4a');
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    const cleanup = () => { try { fs.unlinkSync(tmp); } catch {} };
    let size = 0;
    let overflow = false;
    // Write the upload straight to disk, not memory: 20 MB × N parallel
    // requests in RAM is a memory-exhaustion vector.
    req.on('data', (c) => {
      size += c.length;
      if (size > 20e6 && !overflow) {
        overflow = true;
        try { res.writeHead(413); res.end(); } catch {}
        req.destroy(); out.destroy(); cleanup();
      }
    });
    // client-aborted upload: transcribe never starts ('finish' won't come),
    // so the temp file must be deleted here or it leaks onto the disk
    req.on('error', () => { try { out.destroy(); } catch {} cleanup(); });
    out.on('error', () => { cleanup(); try { res.writeHead(500); res.end(); } catch {} });
    req.pipe(out);
    out.on('finish', async () => {
      if (overflow) return; // response already sent, file deleted
      try {
        const text = await Promise.race([
          transcribe(tmp),
          new Promise((_, rej) => setTimeout(() => rej(new Error('recognition timeout')), 180000)),
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
      } catch (e) {
        // detail goes to the PC log only; the client gets a generic text (no inner paths)
        console.error('[stt] recognition error:', e.message);
        try { res.writeHead(500, { 'Content-Type': 'application/json' }); } catch {}
        res.end(JSON.stringify({ error: 'could not recognize the recording' }));
      } finally {
        cleanup();
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/hook') {
    if (!isLocal(req)) { res.writeHead(403); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { /* keep {} */ }
      const sid = req.headers['x-bridge-session'] || payload.bridge_session || '';
      const event = payload.hook_event_name || 'Notification';
      const message = payload.message || payload.notification || (event === 'Stop' ? 'opencode finished responding' : 'opencode event');
      const s = sessions.get(sid);
      // session status for tabs: working / awaiting approval / idle.
      // PostToolUse — the permission request was answered (incl. on the PC): opencode works again.
      const status = {
        UserPromptSubmit: 'working',
        PostToolUse: 'working',
        Notification: 'waiting',
        Stop: 'idle',
      }[event];
      // a separate event for the phone: on 'working' it clears stale
      // notifications — including for sessions no longer on the list
      if (status && sid && (!s || s.status !== status)) {
        broadcast({ type: 'status', id: sid, status });
      }
      if (s && status && s.status !== status) {
        s.status = status;
        broadcastSessions();
      }
      // push notifications — only for events needing attention
      if (event === 'Notification' || event === 'Stop') {
        if (s) s.lastNotify = { event, message, at: Date.now() };
        broadcast({ type: 'notify', id: sid, event, message, title: s ? s.title : sid, at: Date.now() });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  if (url.pathname === '/health') {
    if (!authed(req, url)) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, host: os.hostname() }));
    return;
  }

  // static: vendor libs from node_modules, everything else from web/
  if (!authed(req, url)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('401: device not paired with the bridge');
    return;
  }
  const extraHeaders = {};
  // token arrived in query -> issue a cookie so css/js/websocket pass on their own
  const qtoken = url.searchParams.get('token');
  if (qtoken) {
    extraHeaders['Set-Cookie'] =
      `bridgeToken=${qtoken}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`;
  }
  let file;
  if (VENDOR[url.pathname]) {
    file = VENDOR[url.pathname];
  } else {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    file = path.join(WEB_DIR, path.normalize(rel));
    // the separator is mandatory: without it a neighbour like .../web-secret
    // would pass the startsWith(WEB_DIR) check (prefix bug)
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
      res.writeHead(403); res.end(); return;
    }
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      ...SEC_HEADERS,
      ...extraHeaders,
    });
    res.end(data);
  });
}

// Main server (LAN + localhost) plus a separate local port for the
// internet tunnel: isLocal() tells them apart by localPort.
const server = https.createServer(TLS, httpHandler);
const tunnelServer = https.createServer(TLS, httpHandler);

// ---------------------------------------------------------------- websocket

const wss = new WebSocketServer({ noServer: true });
function handleUpgrade(req, sock, head) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req));
}
server.on('upgrade', handleUpgrade);
tunnelServer.on('upgrade', handleUpgrade);
const allClients = new Set();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of allClients) if (ws.readyState === 1) ws.send(msg);
}
function broadcastSessions() {
  broadcast({ type: 'sessions', sessions: sessionList(), projects: CONFIG.projects || [] });
}
function devicesMsg(ws) {
  return {
    type: 'devices',
    self: ws.deviceId,
    devices: pairings.devices.map((d) => ({ id: d.id, name: d.name, addedAt: d.addedAt })),
  };
}

wss.on('connection', (ws, req) => {
  const connUrl = new URL(req.url, 'http://x');
  if (!authed(req, connUrl)) {
    ws.close(4401, 'unauthorized');
    return;
  }
  const dev = deviceByToken(requestToken(req, connUrl));
  ws.deviceId = dev ? dev.id : (isLocal(req) ? 'local' : null);
  allClients.add(ws);
  // phone (dis)connections refresh the foot-window client count (local CLI
  // connects on every invocation — not worth reprinting for those)
  if (ws.deviceId && ws.deviceId !== 'local') printStatus();
  ws.attached = null;
  ws.send(JSON.stringify({ type: 'sessions', sessions: sessionList(), projects: CONFIG.projects || [] }));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const s = m.id ? sessions.get(m.id) : null;

    switch (m.type) {
      case 'create': {
        if (sessions.size >= MAX_SESSIONS) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session limit reached' }));
          break;
        }
        if (!rateAllowCreate(ws.deviceId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Too frequent — wait a bit' }));
          break;
        }
        const created = createSession({
          cwd: m.cwd, command: m.command, args: m.args, title: m.title,
          local: ws.deviceId === 'local',
        });
        ws.send(JSON.stringify({ type: 'created', id: created.id }));
        break;
      }
      case 'attach': {
        if (!s) return;
        if (ws.attached) { const old = sessions.get(ws.attached); if (old) old.clients.delete(ws); }
        ws.attached = s.id;
        s.clients.add(ws);
        if (m.cols && m.rows) ws.desired = { cols: m.cols, rows: m.rows };
        // a watcher doesn't change the size — only the sole client does
        if (ws.desired && s.clients.size === 1) resizePty(s, ws.desired.cols, ws.desired.rows);
        ws.send(JSON.stringify({
          type: 'scrollback', id: s.id, data: s.buffer.join(''),
          alive: s.alive, cols: s.cols, rows: s.rows,
        }));
        break;
      }
      case 'input':
        if (s && s.alive) {
            if (s.lastInput !== ws) {
              s.lastInput = ws; // client started typing — PTY adapts to them
            if (ws.desired) resizePty(s, ws.desired.cols, ws.desired.rows);
          }
          keeperSend(s, { t: 'in', d: m.data });
        }
        break;
      case 'scroll':
        // scrolling is not typing: don't touch the PTY "size owner"
        if (s && s.alive) keeperSend(s, { t: 'in', d: m.data });
        break;
      case 'resize':
        if (!s) break;
        if (m.cols > 0 && m.rows > 0) ws.desired = { cols: m.cols, rows: m.rows };
        if (ws.desired && (s.clients.size === 1 || s.lastInput === ws)) {
          resizePty(s, ws.desired.cols, ws.desired.rows);
        }
        break;
      case 'kill':
        if (s && s.alive) keeperSend(s, { t: 'kill' });
        break;
      case 'remove':
        if (s && !s.alive) { sessions.delete(s.id); broadcastSessions(); }
        break;
      case 'list':
        ws.send(JSON.stringify({ type: 'sessions', sessions: sessionList(), projects: CONFIG.projects || [] }));
        break;
      case 'devices':
        // device list — local clients only (desktop browser,
        // opencode-mobile); the phone manages the PC via the native menu, not this
        if (ws.deviceId === 'local') ws.send(JSON.stringify(devicesMsg(ws)));
        break;
      case 'internet':
        // internet-access status: the phone remembers the ticket for later
        ws.send(JSON.stringify(internetMsg()));
        break;
      case 'registerNode': {
        // the phone reports its permanent iroh NodeId (over LAN, via a
        // protected WS) — add it to this device's tunnel allowlist
        const nid = (m.nodeId || '').trim().toLowerCase();
        if (/^[0-9a-f]{64}$/.test(nid) && ws.deviceId && ws.deviceId !== 'local') {
          const dev = pairings.devices.find((d) => d.id === ws.deviceId);
          if (dev && dev.nodeId !== nid) {
            dev.nodeId = nid;
            savePairings();
            writeAllowFile();
            console.log(`  Registered device p2p node “${dev.name}”`);
          }
        }
        break;
      }
      case 'setInternet':
        // on/off — from this PC only (opencode-mobile --device)
        if (ws.deviceId === 'local') {
          setInternet(m.enabled);
          broadcastInternet();
        }
        break;
      case 'pairinfo':
        // pairing data — local clients only (opencode-mobile --qr);
        // every request issues a fresh 5-minute code
        if (ws.deviceId === 'local') {
          const p = regenPairCode();
          ws.send(JSON.stringify({
            type: 'pairinfo',
            host: lanAddress(),
            port: CONFIG.port,
            code: p.code,
            ttlMin: Math.round(PAIR_TTL_MS / 60000),
            fp: FINGERPRINT,
            internet: internetMsg(),
          }));
        }
        break;
      case 'revokeDevice':
        // device revoke — from this PC only (opencode-mobile --device / desktop),
        // otherwise a paired phone could revoke every other device.
        // The device list also goes to the local client ONLY: a remote
        // device would otherwise read everyone else's id/names/dates (F12).
        if (ws.deviceId === 'local') {
          revokeDeviceById(m.id);
          ws.send(JSON.stringify(devicesMsg(ws)));
        }
        break;
    }
  });

  ws.on('close', () => {
    const wasPhone = ws.deviceId && ws.deviceId !== 'local';
    allClients.delete(ws);
    if (ws.attached) { const s = sessions.get(ws.attached); if (s) s.clients.delete(ws); }
    if (wasPhone) printStatus();
  });
});

// ---------------------------------------------------------------- start

function lanAddress() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !name.startsWith('docker') &&
          !name.startsWith('br-') && !name.startsWith('lxc') && !a.address.startsWith('169.254.')) {
        return a.address;
      }
    }
  }
  return '127.0.0.1';
}

// UDP discovery: the phone broadcasts "OPENCODE_BRIDGE?" to port+1,
// the bridge answers unicast with its address. More reliable than mDNS on noisy networks.
const dgram = require('dgram');

// Answer only requests from local networks (RFC1918 / link-local / loopback):
// the beacon must not leak hostname+fingerprint nor serve as an outward reflector.
function isPrivateAddr(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip.startsWith('::ffff:127.')) return true;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const p = v4.split('.').map(Number);
  if (p.length === 4 && p.every((n) => n >= 0 && n <= 255)) {
    if (p[0] === 10) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local
    return false;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fe80:') || l.startsWith('fc') || l.startsWith('fd');
}

const beacon = dgram.createSocket({ type: 'udp4', reuseAddr: true });
beacon.on('message', (msg, rinfo) => {
  if (msg.toString().trim() === 'OPENCODE_BRIDGE?' && isPrivateAddr(rinfo.address)) {
    // fp — the public certificate fingerprint: the phone uses it to tell
    // WHICH of its paired computers answered
    const reply = JSON.stringify({
      opencodeBridge: true, claudeBridge: true, port: CONFIG.port, host: os.hostname(), fp: FINGERPRINT,
    });
    beacon.send(reply, rinfo.port, rinfo.address);
  }
});
beacon.on('error', (e) => console.error('UDP beacon error (non-critical):', e.message));
beacon.bind(CONFIG.port + 1);

// port for internet-tunnel traffic — loopback only
tunnelServer.listen(TUNNEL_PORT, '127.0.0.1');
if (inet.enabled) startTunnel();

server.listen(CONFIG.port, CONFIG.host, () => {
  try {
    const bonjour = new Bonjour();
    bonjour.publish({
      name: CONFIG.mdnsName || 'opencode-bridge',
      type: 'opencode-bridge',
      port: CONFIG.port,
      txt: { path: '/', fp: FINGERPRINT },
    });
  } catch (e) {
    console.error('mDNS publish failed (non-critical):', e.message);
  }

  restoreSessions();

  // No QR/code at startup: the pairing code is issued on demand via
  // opencode-mobile --qr (one code — one device, 5-minute TTL).
  printStatus();
  console.log('  Pairing code is issued on demand: opencode-mobile --qr');
  console.log('');
});

// Restarting the bridge does NOT kill sessions: they live in separate keepers.
// But the internet tunnel is part of the bridge: kill it on exit, otherwise
// under KillMode=process it outlives the restart and doubles the iroh endpoint.
process.on('exit', () => { if (tunnel) { try { tunnel.kill(); } catch { } } });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

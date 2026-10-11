#!/usr/bin/env node
'use strict';
// opencode-mobile: launch opencode through the bridge and mirror the session
// in this terminal. The phone sees the same session and can intervene.
//
//   opencode-mobile [args…]    new session in the current directory; all args
//                            go to opencode (run -c/--continue,
//                            -s/--session, -m/--model etc.)
//   opencode-mobile -l         list sessions
//   opencode-mobile -a [id]    attach to a session (no id — most recent live one)
//   opencode-mobile --device   trusted devices: list and revoke
//   opencode-mobile --qr       show pairing QR code (bridge must run)
//
// Ctrl+\  — detach (session keeps living, phone stays connected)

const path = require('path');
const readline = require('readline');
const WebSocket = require(path.join(__dirname, 'node_modules', 'ws'));

const BRIDGE = process.env.OPENCODE_BRIDGE_URL || process.env.CLAUDE_BRIDGE_URL || 'wss://127.0.0.1:8890/ws';
const args = process.argv.slice(2);

const USAGE = `opencode-mobile — opencode through the bridge (mirror on phone)

  opencode-mobile [args…]     new session in the current directory; args
                             go to opencode itself (run -c/--continue,
                             -s/--session, -m/--model…)
  opencode-mobile -l          list sessions
  opencode-mobile -a [id]     attach to a session (no id — most recent live one)
  opencode-mobile --device    trusted devices: list and revoke (TUI)
  opencode-mobile devices [--json]  list trusted devices (scriptable)
  opencode-mobile revoke <id|number> [-y]  revoke a device (asks without -y)
  opencode-mobile internet [on|off|status]  p2p access over the internet
  opencode-mobile --qr        pairing QR code
  opencode-mobile -h          this help

Device management — from this PC only (the bridge accepts
devices/revoke/setInternet from the local client only).

Ctrl+\\ — detach: the session keeps living, reattach with opencode-mobile -a.
To really end a session: quit opencode (Ctrl+C or /exit)
or long-press its tab in the phone app.`;

// Catch typos in OUR flags before creating a session: otherwise "opencode --l"
// would silently start a session, opencode would reject the flag and die with
// a cryptic "[session exited]".
const TYPOS = new Map([
  ['--l', '-l'], ['-list', '-l'],
  ['--a', '-a'], ['-attach', '-a'],
  ['-device', '--device'], ['-devices', '--device'],
  ['-qr', '--qr'], ['--h', '-h'], ['-help', '-h'],
]);

if (args[0] === '-h' || args[0] === '--help') {
  console.log(USAGE);
  process.exit(0);
}
if (TYPOS.has(args[0])) {
  console.error(`Unknown flag “${args[0]}” — did you mean “${TYPOS.get(args[0])}”?\n`);
  console.error(USAGE);
  process.exit(1);
}

// the bridge cert is self-signed; for localhost that is safe
const ws = new WebSocket(BRIDGE, { rejectUnauthorized: false });
let sid = null;
let decided = false;
let raw = false;

function die(msg, code) {
  cleanup();
  if (msg) console.error(msg);
  process.exit(code || 0);
}

function cleanup() {
  if (raw && process.stdin.isTTY) process.stdin.setRawMode(false);
}

function send(obj) { ws.send(JSON.stringify(obj)); }

function attach(id) {
  sid = id;
  send({
    type: 'attach', id,
    cols: process.stdout.columns || 100,
    rows: process.stdout.rows || 30,
  });
}

let createdAtMs = 0; // when WE created the session — to diagnose instant death

function doCreate() {
  createdAtMs = Date.now();
  const shown = args.length ? 'opencode ' + args.join(' ') : 'opencode';
  console.log(`Starting: ${shown}  (dir ${process.cwd()})`);
  send({ type: 'create', cwd: process.cwd(), args });
}

/**
 * Session creation; before launching with -c/--continue/-s/--session warn
 * about live sessions in the same directory: without --fork, continuing picks
 * up the active conversation's state, and a parallel live session most likely
 * means you should attach instead of starting a new one.
 * opencode natively supports --fork for explicit branching.
 */
function maybeCreate(sessionsList) {
  const resumeLike = args.some((a) =>
    a === '--continue' || a === '-c' || a === '--session' || a === '-s');
  const liveHere = sessionsList.filter((s) => s.alive && s.cwd === process.cwd());
  if (!resumeLike || !liveHere.length) { doCreate(); return; }

  console.log('⚠ Live sessions already exist in this directory:');
  for (const s of liveHere) console.log(`    ${s.id}\t${s.title}`);
  console.log('If a conversation is still open in one of them, continuing without --fork will pick up the same state.');
  console.log(`Back to live session: opencode-mobile -a ${liveHere[liveHere.length - 1].id}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Still create a new session with continue? [y/N]: ', (ans) => {
    rl.close();
    if (/^[yд]/i.test(ans.trim())) doCreate();
    else die('Cancelled.');
  });
}

function enterRaw() {
  if (raw || !process.stdin.isTTY) return;
  raw = true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => {
    if (d.length === 1 && d[0] === 0x1c) { // Ctrl+\
      die('\r\n[detached — session keeps running; reattach: opencode-mobile -a]\r');
    }
    send({ type: 'input', id: sid, data: d.toString('utf8') });
  });
  process.on('SIGWINCH', () => {
    send({ type: 'resize', id: sid, cols: process.stdout.columns, rows: process.stdout.rows });
  });
}

ws.on('error', (e) => die('Bridge unreachable (' + e.message + '). Is bridge/server.js running?', 1));

ws.on('message', (rawMsg) => {
  const m = JSON.parse(rawMsg);
  switch (m.type) {
    case 'sessions': {
      if (decided) return;
      decided = true;
      if (args[0] === '--device' || args[0] === '--devices') {
        send({ type: 'internet' }); // arrives before devices — menu will show the status
        send({ type: 'devices' });
      } else if (args[0] === 'devices') {
        send({ type: 'devices' }); // the answer prints via devices-print below
      } else if (args[0] === 'revoke') {
        if (!args[1] || args[1] === '-h' || args[1] === '--help') {
          die('Usage: opencode-mobile revoke <id|number> [-y]', 1);
        }
        send({ type: 'devices' }); // resolve number/id from the list, then send revoke
      } else if (args[0] === 'internet') {
        const sub = args[1] || 'status';
        if (sub === 'on' || sub === 'off') {
          send({ type: 'setInternet', enabled: sub === 'on' });
          // server broadcasts fresh internet-status to all — our internet-print below
          // catches it and exits; backup — an explicit request a bit later
          setTimeout(() => send({ type: 'internet' }), 800);
        } else if (sub === 'status') {
          send({ type: 'internet' });
        } else {
          die('Usage: opencode-mobile internet [on|off|status]', 1);
        }
      } else if (args[0] === '--qr') {
        send({ type: 'pairinfo' });
      } else if (args[0] === '-l' || args[0] === '--list') {
        if (!m.sessions.length) console.log('No sessions.');
        for (const s of m.sessions) {
          console.log(`${s.id}\t${s.alive ? 'alive' : 'exited'}\t${s.title}\t${s.cwd}`);
        }
        process.exit(0);
      } else if (args[0] === '-a' || args[0] === '--attach') {
        const target = args[1]
          ? m.sessions.find((s) => s.id === args[1])
          : m.sessions.filter((s) => s.alive).pop();
        if (!target) die('No live sessions. Run: opencode-mobile', 1);
        else attach(target.id);
      } else {
        // all other args go to opencode itself
        maybeCreate(m.sessions);
      }
      break;
    }
    case 'created':
      attach(m.id);
      break;
    case 'scrollback':
      enterRaw();
      process.stdout.write(m.data);
      break;
    case 'output':
      if (m.id === sid) process.stdout.write(m.data);
      break;
    case 'exit':
      if (m.id === sid) {
        let msg = `\r\n[session exited, code ${m.exitCode}]`;
        // we created the session, and opencode died almost immediately with an error —
        // it almost certainly rejected the passed args
        if (createdAtMs && m.exitCode !== 0 && Date.now() - createdAtMs < 15000 && args.length) {
          msg += `\r\nopencode exited right after start — possibly rejected the args: opencode ${args.join(' ')}`;
          msg += '\r\nHelp: opencode-mobile -h';
        }
        die(msg, m.exitCode === 0 ? 0 : 1);
      }
      break;
    case 'devices':
      if (args[0] === '--device' || args[0] === '--devices') deviceTui(m);
      else if (args[0] === 'devices') devicesPrint(m);
      else if (args[0] === 'revoke') revokeFlow(m);
      break;
    case 'internet':
      inetState = m;
      if (args[0] === 'internet' && !inetDone) {
        inetDone = true;
        console.log(fmtInet(m));
        process.exit(0);
      }
      break;
    case 'pairinfo': {
      const qrcode = require(path.join(__dirname, 'node_modules', 'qrcode-terminal'));
      console.log('\nPairing a new device with OpenCode Bridge');
      console.log(`Bridge address: ${m.host}:${m.port}`);
      if (m.internet) console.log(`Internet access: ${fmtInet(m.internet)}`);
      console.log(`Manual entry code: ${m.code}  (valid ${m.ttlMin || 10} minutes)\n`);
      qrcode.generate(JSON.stringify({ ob: 1, host: m.host, port: m.port, code: m.code, fp: m.fp }),
        { small: true }, (q) => { console.log(q); process.exit(0); });
      break;
    }
  }
});

// ------------------------------- TUI: trusted devices + internet access

let rl = null;
let inetState = null;
let inetDone = false;
let revokeSent = false;

// ------------------------------- Scriptable control (no TUI)

function devicesPrint(m) {
  if (args.includes('--json')) {
    console.log(JSON.stringify(m.devices, null, 2));
  } else {
    if (!m.devices.length) console.log('(no paired devices)');
    m.devices.forEach((d, i) => {
      console.log(`${i + 1}. ${d.id}  ${d.name}  (added ${d.addedAt})`);
    });
  }
  process.exit(0);
}

function revokeFlow(m) {
  if (revokeSent) {
    // server sent the refreshed list after revoke — show the total
    console.log('Revoked. Devices left: ' + m.devices.length);
    devicesPrint(m);
    return;
  }
  const want = args[1];
  const n = parseInt(want, 10);
  const dev = m.devices[Number.isInteger(n) ? n - 1 : -1] ||
    m.devices.find((d) => d.id === want || d.id.startsWith(want));
  if (!dev) die(`Device “${want}” not found. See: opencode-mobile devices`, 1);
  const go = () => {
    revokeSent = true;
    send({ type: 'revokeDevice', id: dev.id });
  };
  if (args.includes('-y') || args.includes('--yes')) go();
  else {
    const q = readline.createInterface({ input: process.stdin, output: process.stdout });
    q.question(`Revoke “${dev.name}” (${dev.id})? The device will lose access immediately [y/N]: `, (yn) => {
      q.close();
      if (/^[yд]/i.test(yn.trim())) go();
      else die('Cancelled.');
    });
  }
}

function fmtInet(s) {
  if (!s) return 'status unknown';
  if (!s.available) return 'unavailable: bridge/bin/opencode-tunnel not built';
  if (!s.enabled) return 'off';
  let line = 'ON' + (s.ticket ? '' : ' (p2p endpoint starting…)');
  if (s.peers && s.peers.length) {
    const paths = s.peers.map((p) =>
      (p.path === 'direct' ? 'direct' : p.path === 'relay' ? 'via relay' : '…') +
      (p.rttMs != null ? ` ${Math.round(p.rttMs)} ms` : '')).join(', ');
    line += `; internet connections: ${s.peers.length} (${paths})`;
  }
  return line;
}

function deviceTui(m) {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\nBridge trusted devices:');
  if (!m.devices.length) console.log('  (no paired devices)');
  m.devices.forEach((d, i) => {
    const self = d.id === m.self ? '  [this device]' : '';
    console.log(`  ${i + 1}. ${d.name}  ·  added ${new Date(d.addedAt).toLocaleString('en-US')}${self}`);
  });
  console.log(`\nInternet access (p2p iroh): ${fmtInet(inetState)}`);

  rl.question('\nNumber — revoke device, i — toggle internet, Enter — exit: ', (ans) => {
    ans = ans.trim();
    if (/^[iи]$/i.test(ans)) {
      send({ type: 'setInternet', enabled: !(inetState && inetState.enabled) });
      // server broadcasts fresh internet-status; re-request the menu
      setTimeout(() => { send({ type: 'internet' }); send({ type: 'devices' }); }, 400);
      return;
    }
    const n = parseInt(ans, 10);
    const dev = m.devices[n - 1];
    if (!dev) { console.log('Exiting.'); process.exit(0); }
    rl.question(`Revoke “${dev.name}”? The device will lose access immediately [y/N]: `, (yn) => {
      if (/^[yд]/i.test(yn.trim())) {
        send({ type: 'revokeDevice', id: dev.id });
        console.log('Revoked.');
        // server will send the refreshed list — TUI shows it again
      } else {
        console.log('Cancelled.');
        process.exit(0);
      }
    });
  });
}

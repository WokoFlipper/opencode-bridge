#!/usr/bin/env node
'use strict';
// Session keeper: a separate process owning the PTY independently of the bridge.
// The bridge may restart — the opencode session keeps living.
// Protocol: JSON lines over a unix socket next to the meta file.

const fs = require('fs');
const net = require('net');
const path = require('path');
const pty = require(path.join(__dirname, 'node_modules', 'node-pty'));

const metaPath = process.argv[2];
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const sockPath = metaPath.replace(/\.json$/, '.sock');
// The sessions dir must be 0700: the keeper socket has no authentication
// of its own, and access to it equals control over a live opencode session.
try { fs.chmodSync(path.dirname(sockPath), 0o700); } catch {}
try { fs.unlinkSync(sockPath); } catch {}

// Environment comes from the bridge via process.env (never written into the
// meta file, so secrets stay off disk). meta.env is only for compatibility
// with old meta files on the first run after an upgrade.
const term = pty.spawn(meta.cmd, meta.args || [], {
  name: 'xterm-256color',
  cols: meta.cols || 100,
  rows: meta.rows || 30,
  cwd: meta.cwd,
  env: meta.env || process.env,
});

const LIMIT = meta.scrollbackBytes || 262144;
let buffer = [];
let bytes = 0;
const clients = new Set();

function sendTo(c, obj) {
  try { c.write(JSON.stringify(obj) + '\n'); } catch {}
}

term.onData((d) => {
  buffer.push(d);
  bytes += Buffer.byteLength(d);
  while (bytes > LIMIT && buffer.length > 1) bytes -= Buffer.byteLength(buffer.shift());
  for (const c of clients) sendTo(c, { t: 'out', d });
});

term.onExit(({ exitCode }) => {
  for (const c of clients) sendTo(c, { t: 'exit', code: exitCode });
  try { fs.unlinkSync(sockPath); } catch {}
  try { fs.unlinkSync(metaPath); } catch {}
  setTimeout(() => process.exit(0), 200);
});

const srv = net.createServer((c) => {
  clients.add(c);
  sendTo(c, { t: 'hello', buffer: buffer.join(''), cols: term.cols, rows: term.rows, pid: term.pid });
  let acc = '';
  c.on('data', (chunk) => {
    acc += chunk.toString('utf8');
    let i;
    while ((i = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, i);
      acc = acc.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.t === 'in') term.write(m.d);
      else if (m.t === 'resize' && m.cols > 0 && m.rows > 0) {
        try { term.resize(m.cols, m.rows); } catch {}
      } else if (m.t === 'kill') {
        try { term.kill(); } catch {}
      }
    }
  });
  c.on('close', () => clients.delete(c));
  c.on('error', () => clients.delete(c));
});
srv.listen(sockPath);

process.on('SIGTERM', () => { try { term.kill(); } catch {} });

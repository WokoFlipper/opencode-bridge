'use strict';
/* global Terminal, FitAddon */

const $ = (s) => document.querySelector(s);
const ESC = '\x1b';
const KEYS = {
  esc: ESC,
  tab: '\t',
  shifttab: ESC + '[Z',
  up: ESC + '[A',
  down: ESC + '[B',
  left: ESC + '[D',
  right: ESC + '[C',
  enter: '\r',
  ctrlc: '\x03',
};

let ws = null;
let sessions = [];
let projects = [];
let current = localStorage.getItem('currentSession') || null;
let reconnectDelay = 500;
let audioCtx = null;

// ------------------------------------------------------------ terminal

const term = new Terminal({
  fontSize: 13,
  fontFamily: 'Menlo, monospace',
  theme: { background: '#0b1120' },
  cursorBlink: true,
  scrollback: 10000,
});
term.open($('#terminal'));

term.onData((data) => send({ type: 'input', id: current, data }));

// The local terminal mirrors the actual PTY size (reported by the server).
// We only "propose" our sizes — the server applies them when we type.
const wrap = $('#termwrap');

function cellSize() {
  try {
    const c = term._core._renderService.dimensions.css.cell;
    if (c.width && c.height) return c;
  } catch {}
  return { width: 8, height: 17 };
}

function viewport() {
  const c = cellSize();
  return {
    cols: Math.max(20, Math.floor((wrap.clientWidth - 8) / c.width)),
    rows: Math.max(8, Math.floor((wrap.clientHeight - 8) / c.height)),
  };
}

const refit = () => {
  if (!current) return;
  const v = viewport();
  send({ type: 'resize', id: current, cols: v.cols, rows: v.rows });
};
window.addEventListener('resize', refit);
if (window.visualViewport) window.visualViewport.addEventListener('resize', refit);

// Finger scrolling.
// Normal buffer (bash etc.) — scroll xterm's scrollback.
// Alternate screen (agent TUI) — send the app wheel events:
// the TUI redraws its own history, including --continue restores.
function sendScroll(lines) {
  if (!current) return;
  const n = Math.min(Math.abs(lines), 10);
  const mouse = term.modes.mouseTrackingMode !== 'none';
  const col = Math.max(1, Math.round(term.cols / 2));
  const row = Math.max(1, Math.round(term.rows / 2));
  let data = '';
  for (let i = 0; i < n; i++) {
    if (mouse) data += `\x1b[<${lines > 0 ? 64 : 65};${col};${row}M`; // wheel up/down
    else data += lines > 0 ? '\x1b[5~' : '\x1b[6~'; // PageUp / PageDown
  }
  // 'scroll' — like input, but doesn't switch the PTY "size owner"
  send({ type: 'scroll', id: current, data });
}

// ------------------------------------------- text selection in the terminal
// Like in text fields: a long press selects the word under the finger, with
// two handles appearing at the edges — each draggable separately, char by char.

const sel = {
  active: false,
  a: null, // {line, col} — start (invariant: a <= b)
  b: null, // {line, col} — end (inclusive)
};
const handleEnd = { A: 'a', B: 'b' }; // which handle leads which end

function cmpPos(p, q) { return (p.line - q.line) || (p.col - q.col); }

// buffer cell position under screen coordinates
function posAt(clientX, clientY) {
  const rect = term.element.getBoundingClientRect();
  const c = cellSize();
  const col = Math.max(0, Math.min(Math.floor((clientX - rect.left) / c.width), term.cols - 1));
  const bu = term.buffer.active;
  const line = Math.max(0, Math.min(
    bu.viewportY + Math.floor((clientY - rect.top) / c.height), bu.length - 1));
  return { line, col };
}

// word (a contiguous non-space run) around a position
function wordAt(pos) {
  const lineObj = term.buffer.active.getLine(pos.line);
  const text = lineObj ? lineObj.translateToString() : '';
  const isW = (ch) => !!ch && /\S/.test(ch);
  let s = pos.col;
  let e = pos.col;
  if (isW(text[pos.col])) {
    while (s > 0 && isW(text[s - 1])) s--;
    while (e < term.cols - 1 && isW(text[e + 1])) e++;
  }
  return { a: { line: pos.line, col: s }, b: { line: pos.line, col: e } };
}

// Dragging handles — via document: events aren't lost even if the finger
// slides off the handle or under other elements.
let dragH = null; // { h, id }

function makeHandle() {
  const h = document.createElement('div');
  h.className = 'selh hidden';
  wrap.appendChild(h);
  h.addEventListener('pointerdown', (e) => {
    if (!sel.active) return;
    e.preventDefault();
    e.stopPropagation();
    dragH = { h, id: e.pointerId };
    try { h.setPointerCapture(e.pointerId); } catch {}
  });
  return h;
}
const selhA = makeHandle();
const selhB = makeHandle();

function dragMoveTo(clientX, clientY) {
  // the handle hangs below the line: aim at the line above the finger
  const p = posAt(clientX, clientY - 12 - cellSize().height / 2);
  const key = dragH.h === selhA ? 'A' : 'B';
  sel[handleEnd[key]] = p;
  if (cmpPos(sel.a, sel.b) > 0) {
    // ends swapped places — the finger now leads the other end
    const t = sel.a; sel.a = sel.b; sel.b = t;
    const o = handleEnd.A; handleEnd.A = handleEnd.B; handleEnd.B = o;
  }
  applySelection();
}

// Autoscroll: a finger/handle at the terminal's top or bottom edge scrolls
// history, the selection stretches after it. Works both when stretching with
// the same finger after a long press and when dragging handles.
// In the normal buffer we scroll xterm's scrollback; on the alternate screen
// (agent TUI) we send the app the mouse wheel — content scrolls under the
// selection, and what is highlighted on screen gets copied.
const AUTOSCROLL_ZONE = 48;
let autoTimer = null;
let lastDragXY = null;
let autoMode = null; // 'handle' — dragging a handle, 'press' — finger after long-press

function stopAutoScroll() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  autoMode = null;
  altBusy = false;
}

function autoScrollDir(y) {
  const r = wrap.getBoundingClientRect();
  if (y < r.top + AUTOSCROLL_ZONE) return -1;
  if (y > r.bottom - AUTOSCROLL_ZONE) return 1;
  return 0;
}

// stretching the selection with a finger after a long press.
// Anchor — the original word (pressWord); the finger only extends the selection
// toward itself, the word itself always stays inside. So on autoscroll up,
// the bottom edge (anchor) never gets lost.
let pressWord = null;
function pressMoveTo(x, y) {
  if (!pressWord) return;
  const p = posAt(x, y);
  sel.a = cmpPos(p, pressWord.a) < 0 ? p : { line: pressWord.a.line, col: pressWord.a.col };
  sel.b = cmpPos(p, pressWord.b) > 0 ? p : { line: pressWord.b.line, col: pressWord.b.col };
  applySelection();
}

// snapshot of visible lines — to tell how far the TUI shifted content
function viewportSnapshot() {
  const b = term.buffer.active;
  const out = [];
  for (let i = 0; i < term.rows; i++) {
    const l = b.getLine(b.viewportY + i);
    out.push(l ? l.translateToString().trim() : '');
  }
  return out;
}

// how many lines the content shifted between snapshots (0 — can't tell)
function detectShift(prev, next, dir) {
  let best = 0;
  let bestScore = 0;
  for (let s = 1; s <= 6; s++) {
    let match = 0;
    let total = 0;
    for (let i = 0; i < prev.length; i++) {
      const j = dir < 0 ? i + s : i - s;
      if (j < 0 || j >= next.length || !prev[i]) continue;
      total++;
      if (prev[i] === next[j]) match++;
    }
    const score = total ? match / total : 0;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= 0.5 ? best : 0;
}

let altBusy = false; // waiting for the TUI to redraw after the sent wheel

function followFinger() {
  if (!lastDragXY || !sel.active) return;
  if (autoMode === 'handle' && dragH) dragMoveTo(lastDragXY.x, lastDragXY.y);
  else if (autoMode === 'press') pressMoveTo(lastDragXY.x, lastDragXY.y);
}

function autoStep() {
  if (!sel.active || !lastDragXY) { stopAutoScroll(); return; }
  if (autoMode === 'handle' && !dragH) { stopAutoScroll(); return; }
  const d = autoScrollDir(lastDragXY.y);
  if (!d) { stopAutoScroll(); return; }
  if (term.buffer.active.type === 'alternate') {
    // The TUI itself (opencode) owns the history: we send the wheel, and after
    // its redraw shift the selection by as many lines — it stays "glued"
    // to the text until the text scrolls off screen.
    if (altBusy) return;
    altBusy = true;
    const prev = viewportSnapshot();
    sendScroll(-d);
    setTimeout(() => {
      altBusy = false;
      if (!sel.active) return;
      const s = detectShift(prev, viewportSnapshot(), d);
      if (s) {
        const shift = d < 0 ? s : -s;
        const maxL = term.buffer.active.length - 1;
        const mv = (p) => { p.line = Math.max(0, Math.min(p.line + shift, maxL)); };
        mv(sel.a);
        mv(sel.b);
        if (pressWord) { mv(pressWord.a); mv(pressWord.b); }
      }
      followFinger();
      applySelection();
    }, 250);
    return;
  }
  term.scrollLines(d);
  followFinger(); // selection end stays under the finger, catching the scrolled part
}

function ensureAutoScroll(mode, x, y) {
  lastDragXY = { x, y };
  autoMode = mode;
  const dir = autoScrollDir(y);
  if (dir && !autoTimer) autoTimer = setInterval(autoStep, 100);
  else if (!dir) stopAutoScroll();
}

document.addEventListener('pointermove', (e) => {
  if (!dragH || e.pointerId !== dragH.id || !sel.active) return;
  e.preventDefault();
  dragMoveTo(e.clientX, e.clientY);
  ensureAutoScroll('handle', e.clientX, e.clientY);
}, { passive: false });
document.addEventListener('pointerup', (e) => {
  if (dragH && e.pointerId === dragH.id) { dragH = null; stopAutoScroll(); }
});
document.addEventListener('pointercancel', (e) => {
  if (dragH && e.pointerId === dragH.id) { dragH = null; stopAutoScroll(); }
});

function applySelection() {
  if (!sel.active) return;
  const len = (sel.b.line - sel.a.line) * term.cols + (sel.b.col - sel.a.col) + 1;
  term.select(sel.a.col, sel.a.line, Math.max(1, len));
  positionHandles();
}

function positionHandles() {
  const c = cellSize();
  const termRect = term.element.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const vy = term.buffer.active.viewportY;
  const baseX = termRect.left - wrapRect.left + wrap.scrollLeft;
  const baseY = termRect.top - wrapRect.top + wrap.scrollTop;
  const place = (h, p, endEdge) => {
    const vis = sel.active && p.line >= vy && p.line < vy + term.rows;
    h.classList.toggle('hidden', !vis);
    if (!vis) return;
    h.style.left = (baseX + (p.col + (endEdge ? 1 : 0)) * c.width) + 'px';
    h.style.top = (baseY + (p.line - vy + 1) * c.height) + 'px';
  };
  const hStart = handleEnd.A === 'a' ? selhA : selhB;
  const hEnd = hStart === selhA ? selhB : selhA;
  place(hStart, sel.a, false);
  place(hEnd, sel.b, true);
}

function clearSel() {
  sel.active = false;
  term.clearSelection();
  selhA.classList.add('hidden');
  selhB.classList.add('hidden');
  hideSelBar();
}

// selection "rides" scrolling and resizes
term.onScroll(() => { if (sel.active) positionHandles(); });
term.onResize(() => { if (sel.active) clearSel(); });

// Finger scrolling + long press (word selection).
(() => {
  let ty = null;
  let tx = null;
  let selTimer = null;
  let dragSel = false; // same finger after long press drags the end
  const el = term.element;

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    // intercept the whole gesture: otherwise Android's native long-press
    // "eats" the finger (touchcancel) and selection stretching breaks off
    e.preventDefault();
    ty = e.touches[0].clientY;
    tx = e.touches[0].clientX;
    if (sel.active) clearSel(); // tap on terminal clears selection
    dragSel = false; // the previous gesture may have broken off without touchend
    clearTimeout(selTimer);
    const x = tx;
    const y = ty;
    selTimer = setTimeout(() => {
      dragSel = true;
      sel.active = true;
      handleEnd.A = 'a';
      handleEnd.B = 'b';
      const w = wordAt(posAt(x, y));
      sel.a = w.a;
      sel.b = w.b;
      pressWord = { a: w.a, b: w.b }; // fixed anchor for the whole gesture
      applySelection();
      showSelBar();
      if (navigator.vibrate) navigator.vibrate(30);
    }, 500);
  }, { passive: false });

  el.addEventListener('touchmove', (e) => {
    if (ty == null) return;
    const cy = e.touches[0].clientY;
    const cx = e.touches[0].clientX;
    const dy = cy - ty;
    const dx = cx - tx;
    if (dragSel && sel.active) {
      // long-press continues: lead the selection end (+edge autoscroll)
      pressMoveTo(cx, cy);
      ensureAutoScroll('press', cx, cy);
      e.preventDefault();
      return;
    }
    // finger moved noticeably — it's a scroll, not a long press
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) clearTimeout(selTimer);
    if (Math.abs(dx) > Math.abs(dy)) return;
    const ch = cellSize().height;
    const lines = Math.trunc(dy / ch);
    if (lines) {
      if (term.buffer.active.type === 'alternate') sendScroll(lines);
      else term.scrollLines(-lines);
      ty += lines * ch;
    }
    e.preventDefault();
  }, { passive: false });

  const endTouch = () => {
    clearTimeout(selTimer);
    ty = null;
    if (dragSel) stopAutoScroll();
    dragSel = false;
  };
  el.addEventListener('touchend', endTouch, { passive: true });
  el.addEventListener('touchcancel', endTouch, { passive: true });
})();

// -------------------------------------------------- copy and paste

function showSelBar() { $('#selbar').classList.remove('hidden'); }
function hideSelBar() { $('#selbar').classList.add('hidden'); }

$('#selCopy').addEventListener('click', () => {
  const text = term.getSelection();
  if (text) {
    if (typeof window.AndroidApp !== 'undefined' && window.AndroidApp.copyText) {
      window.AndroidApp.copyText(text);
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    banner('📋 Copied: ' + text.length + ' chars.');
  }
  clearSel();
});
$('#selCancel').addEventListener('click', clearSel);

$('#pasteBtn').addEventListener('click', async () => {
  let text = '';
  if (typeof window.AndroidApp !== 'undefined' && window.AndroidApp.pasteText) {
    text = window.AndroidApp.pasteText() || '';
  } else if (navigator.clipboard) {
    try { text = await navigator.clipboard.readText(); } catch { /* no access */ }
  }
  if (!text) { banner('📋 Clipboard empty'); return; }
  // paste into the input field (at cursor) — sending is a separate button
  const inp = $('#msg');
  const s = inp.selectionStart == null ? inp.value.length : inp.selectionStart;
  const e = inp.selectionEnd == null ? inp.value.length : inp.selectionEnd;
  inp.value = inp.value.slice(0, s) + text + inp.value.slice(e);
  const np = s + text.length;
  try { inp.setSelectionRange(np, np); } catch { /* non-critical */ }
  inp.focus();
});

// "To end" button: appears when we've scrolled up
const toBottom = $('#toBottom');
toBottom.addEventListener('click', () => term.scrollToBottom());
term.onScroll(() => {
  const b = term.buffer.active;
  toBottom.classList.toggle('hidden', b.viewportY >= b.baseY);
});
term.onWriteParsed(() => {
  const b = term.buffer.active;
  toBottom.classList.toggle('hidden', b.viewportY >= b.baseY);
});

// ------------------------------------------------------------ websocket

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return; // one reconnect loop, not several
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
}

function bridgeWsUrl() {
  // inside the app the page lives locally (assets), and the bridge is reached
  // via the local TLS-pinned ws proxy — the app hands out the address
  if (typeof window.AndroidApp !== 'undefined' && window.AndroidApp.wsUrl) {
    return window.AndroidApp.wsUrl();
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; // already connecting/connected
  ws = new WebSocket(bridgeWsUrl());

  ws.onopen = () => {
    reconnectDelay = 500;
    setStatus('🟢'); // panel shows just the dot to save space
    if (current) attach(current, false);
  };

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'sessions':
        sessions = m.sessions;
        projects = m.projects || [];
        renderTabs();
        if (current && !sessions.find((s) => s.id === current)) {
          current = sessions.length ? sessions[0].id : null;
          if (current) attach(current, true);
          else { document.body.classList.remove('has-session'); term.clear(); }
        }
        if (!current && sessions.length) attach(sessions[0].id, true);
        break;
      case 'created':
        attach(m.id, true);
        break;
      case 'scrollback':
        term.reset();
        if (m.cols && m.rows) term.resize(m.cols, m.rows);
        term.write(m.data);
        break;
      case 'resized':
        if (m.id === current) term.resize(m.cols, m.rows);
        break;
      case 'output':
        if (m.id === current) term.write(m.data);
        break;
      case 'exit':
        if (m.id === current) term.write(`\r\n\x1b[31m[process exited, code ${m.exitCode}]\x1b[0m\r\n`);
        break;
      case 'notify':
        onNotify(m);
        break;
      case 'devices':
        renderDevices(m);
        break;
    }
  };

  ws.onclose = () => {
    setStatus('🔴 reconnecting…');
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

const NO_ID_TYPES = ['create', 'list', 'devices'];
function send(obj) {
  if (ws && ws.readyState === 1 && (obj.id || NO_ID_TYPES.includes(obj.type))) {
    ws.send(JSON.stringify(obj));
  }
}

function setStatus(t) { $('#status').textContent = t; }

// ------------------------------------------------------------ sessions ui

function attach(id, save) {
  current = id;
  if (save) localStorage.setItem('currentSession', id);
  document.body.classList.add('has-session');
  const v = viewport();
  send({ type: 'attach', id, cols: v.cols, rows: v.rows });
  renderTabs();
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  for (const s of sessions) {
    const b = document.createElement('button');
    b.className = 'tab' + (s.id === current ? ' active' : '') + (s.alive ? '' : ' dead');
    b.textContent = s.title;
    if (s.alive && (s.status === 'waiting' || s.status === 'working')) {
      const dot = document.createElement('span');
      dot.className = 'dot ' + s.status; // 🟠 awaiting approval / 🔵 working
      dot.textContent = ' ●';
      b.appendChild(dot);
    }
    b.onclick = () => { s.lastNotify = null; attach(s.id, true); };
    let t;
    b.oncontextmenu = (e) => { e.preventDefault(); askKill(s); };
    b.addEventListener('touchstart', () => { t = setTimeout(() => askKill(s), 700); }, { passive: true });
    b.addEventListener('touchend', () => clearTimeout(t));
    tabs.appendChild(b);
  }
}

function askKill(s) {
  const q = s.alive ? `End session “${s.title}”?` : `Remove “${s.title}” from the list?`;
  if (window.confirm(q)) send({ type: s.alive ? 'kill' : 'remove', id: s.id });
}

// ------------------------------------------------------------ notifications

function beep() {
  try {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 880; g.gain.value = 0.06;
    o.start(); o.stop(audioCtx.currentTime + 0.18);
  } catch {}
}

function onNotify(m) {
  const text = `${m.title || m.id}: ${m.message}`;
  const banner = $('#banner');
  banner.textContent = '🔔 ' + text;
  banner.classList.remove('hidden');
  banner.onclick = () => { banner.classList.add('hidden'); if (m.id) attach(m.id, true); };
  setTimeout(() => banner.classList.add('hidden'), 15_000);

  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  beep();

  if (window.Notification && Notification.permission === 'granted' && document.hidden) {
    try { new Notification('opencode', { body: text }); } catch {}
  }
  renderTabs();
}

// first tap: enable sound and ask for notification permission
document.body.addEventListener('pointerdown', function once() {
  document.body.removeEventListener('pointerdown', once);
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  if (window.Notification && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}, { once: true });

// ------------------------------------------------------------ controls

for (const btn of document.querySelectorAll('#keys button')) {
  btn.addEventListener('click', () => {
    const seq = KEYS[btn.dataset.key];
    if (seq && current) send({ type: 'input', id: current, data: seq });
  });
}

function sendMessage() {
  const inp = $('#msg');
  if (!current) return;
  if (inp.value) send({ type: 'input', id: current, data: inp.value });
  send({ type: 'input', id: current, data: '\r' });
  inp.value = '';
}
$('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendMessage(); } });

// ------------------------------------------------------------ voice input
// Long press on the send button: recording via the native bridge (AndroidSTT),
// recognition — whisper on the PC. “Accept” puts the text in the field for
// editing, “Enter” sends it to opencode right away.

const voice = {
  el: $('#voice'),
  mic: $('#voiceMic'),
  timer: $('#voiceTimer'),
  hint: $('#voiceHint'),
  btns: $('#voiceBtns'),
  recording: false,
  pressTimer: null,
  suppressClick: false,
  tickTimer: null,
  startedAt: 0,
};

function voiceAvailable() { return typeof window.AndroidSTT !== 'undefined'; }

function voiceTick() {
  const s = Math.floor((Date.now() - voice.startedAt) / 1000);
  voice.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function voiceBegin() {
  if (!voiceAvailable() || voice.recording) return;
  if (!window.AndroidSTT.start()) {
    banner('🎤 No microphone access — allow it and try again');
    return;
  }
  voice.recording = true;
  voice.suppressClick = true;
  voice.startedAt = Date.now();
  voice.el.classList.remove('hidden');
  voice.el.classList.add('rec');
  voice.el.classList.remove('busy');
  voice.btns.classList.add('hidden');
  voice.hint.textContent = 'Speak… release the button when done';
  voiceTick();
  voice.tickTimer = setInterval(voiceTick, 500);
  if (navigator.vibrate) navigator.vibrate(40);
}

function voiceRelease() {
  if (!voice.recording) return;
  voice.recording = false;
  clearInterval(voice.tickTimer);
  window.AndroidSTT.stop();
  voice.el.classList.remove('rec');
  voice.hint.textContent = '“Accept” puts text in the input field, “Enter” sends it to opencode right away';
  voice.btns.classList.remove('hidden');
}

function voiceClose() {
  clearInterval(voice.tickTimer);
  voice.recording = false;
  voice.el.classList.add('hidden');
}

let voiceMode = 'accept';
function voiceTranscribe(mode) {
  voiceMode = mode;
  voice.btns.classList.add('hidden');
  voice.el.classList.add('busy');
  voice.hint.textContent = 'Processing audio…';
  voice.mic.textContent = '⏳';
  window.AndroidSTT.transcribe();
}

window.sttResult = (text) => {
  voice.mic.textContent = '🎤';
  voiceClose();
  text = (text || '').trim();
  if (!text) { banner('🎤 Speech not recognized'); return; }
  if (voiceMode === 'send' && current) {
    send({ type: 'input', id: current, data: text });
    send({ type: 'input', id: current, data: '\r' });
  } else {
    const inp = $('#msg');
    inp.value = text;
    inp.focus();
  }
};

window.sttError = (msg) => {
  voice.mic.textContent = '🎤';
  voiceClose();
  banner('🎤 Recognition error: ' + msg);
};

function banner(text) {
  const b = $('#banner');
  b.textContent = text;
  b.classList.remove('hidden');
  b.onclick = () => b.classList.add('hidden');
  setTimeout(() => b.classList.add('hidden'), 6000);
}

$('#voiceCancel').addEventListener('click', () => { window.AndroidSTT.cancel(); voiceClose(); });
$('#voiceAccept').addEventListener('click', () => voiceTranscribe('accept'));
$('#voiceSend').addEventListener('click', () => voiceTranscribe('send'));

const sendBtn = $('#send');
sendBtn.addEventListener('contextmenu', (e) => e.preventDefault());
sendBtn.addEventListener('pointerdown', (e) => {
  voice.suppressClick = false;
  if (!voiceAvailable()) return;
  // pointer capture: the finger may shake and slide off the button —
  // events still land here, the recording won't break off
  try { sendBtn.setPointerCapture(e.pointerId); } catch {}
  voice.pressTimer = setTimeout(voiceBegin, 350);
});
const endPress = (e) => {
  clearTimeout(voice.pressTimer);
  try { sendBtn.releasePointerCapture(e.pointerId); } catch {}
  if (voice.recording) voiceRelease();
};
sendBtn.addEventListener('pointerup', endPress);
sendBtn.addEventListener('pointercancel', endPress);
sendBtn.addEventListener('click', (e) => {
  if (voice.suppressClick) { e.preventDefault(); return; }
  sendMessage();
});

// ------------------------------------------------------------ devices dialog

$('#devBtn').addEventListener('click', () => {
  // in the app, all settings (computers + devices) live on the native screen
  if (typeof window.AndroidApp !== 'undefined') {
    window.AndroidApp.openSettings();
    return;
  }
  $('#devList').textContent = 'Loading…';
  send({ type: 'devices' });
  $('#devDialog').showModal();
});
$('#devClose').addEventListener('click', () => $('#devDialog').close());

function renderDevices(m) {
  const box = $('#devList');
  box.innerHTML = '';
  if (!m.devices.length) {
    box.textContent = 'No paired devices.';
    return;
  }
  for (const d of m.devices) {
    const row = document.createElement('div');
    row.className = 'dev';

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = d.name + ' ';
    if (d.id === m.self) {
      const self = document.createElement('span');
      self.className = 'self';
      self.textContent = '● this device';
      name.appendChild(self);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = 'added ' + new Date(d.addedAt).toLocaleString();
    info.appendChild(name);
    info.appendChild(meta);
    row.appendChild(info);

    const btn = document.createElement('button');
    btn.textContent = 'Revoke';
    btn.onclick = () => {
      const warn = d.id === m.self
        ? `Revoke THIS device? Will need re-pairing.`
        : `Revoke “${d.name}”? The device will lose access immediately.`;
      if (window.confirm(warn)) send({ type: 'revokeDevice', id: d.id });
    };
    row.appendChild(btn);
    box.appendChild(row);
  }
}

// ------------------------------------------------------------ new session dialog

$('#newBtn').addEventListener('click', () => {
  const sel = $('#projectSel');
  sel.innerHTML = '';
  for (const p of projects) {
    const o = document.createElement('option');
    o.value = p; o.textContent = p;
    sel.appendChild(o);
  }
  $('#projectCustom').value = '';
  $('#newDialog').showModal();
});
$('#createCancel').addEventListener('click', () => $('#newDialog').close());
$('#createOk').addEventListener('click', () => {
  const cwd = $('#projectCustom').value.trim() || $('#projectSel').value;
  const cargs = [];
  if ($('#optResume').checked) cargs.push('--continue');
  if ($('#optDanger').checked) {
    if (!cargs.includes('--continue')) cargs.push('--continue');
    cargs.push('--fork');
  }
  // --continue with a live session in the same directory: continuing picks up
  // the active conversation's state — offer to go back to the live session,
  // and keep --fork for explicit branching.
  if (cargs.includes('--continue')) {
    const norm = (p) => (p || '').replace(/\/+$/, '');
    const live = sessions.filter((s) => s.alive && norm(s.cwd) === norm(cwd));
    if (live.length && window.confirm(
        `“${cwd}” already has a live session: ${live[0].title}.\n` +
        `Continuing will pick up its state; a copy needs --fork.\n\n` +
        `Open the live session instead?`)) {
      $('#newDialog').close();
      attach(live[0].id, true);
      return;
    }
  }
  send({ type: 'create', cwd, args: cargs });
  $('#newDialog').close();
});

connect();

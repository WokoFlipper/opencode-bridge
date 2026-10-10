#!/usr/bin/env node
'use strict';
// opencode-mobile: запустить opencode через мост и зеркалировать сессию
// в этом терминале. Телефон видит ту же сессию и может вмешиваться.
//
//   opencode-mobile [args…]    новая сессия в текущем каталоге; все аргументы
//                            передаются opencode (run -c/--continue,
//                            -s/--session, -m/--model и т.д.)
//   opencode-mobile -l         список сессий
//   opencode-mobile -a [id]    подключиться к сессии (без id — к последней живой)
//   opencode-mobile --device   доверенные устройства: просмотр и отзыв
//   opencode-mobile --qr       показать QR-код сопряжения (мост должен работать)
//
// Ctrl+\  — отсоединиться (сессия продолжает жить, телефон остаётся подключён)

const path = require('path');
const readline = require('readline');
const WebSocket = require(path.join(__dirname, 'node_modules', 'ws'));

const BRIDGE = process.env.OPENCODE_BRIDGE_URL || process.env.CLAUDE_BRIDGE_URL || 'wss://127.0.0.1:8890/ws';
const args = process.argv.slice(2);

const USAGE = `opencode-mobile — opencode через мост (зеркало на телефон)

  opencode-mobile [args…]     новая сессия в текущем каталоге; аргументы
                             передаются самому opencode (run -c/--continue,
                             -s/--session, -m/--model…)
  opencode-mobile -l          список сессий
  opencode-mobile -a [id]     подключиться к сессии (без id — к последней живой)
  opencode-mobile --device    доверенные устройства: просмотр и отзыв (TUI)
  opencode-mobile devices [--json]  список доверенных устройств (скриптуемо)
  opencode-mobile revoke <id|номер> [-y]  отозвать устройство (без -y спросит)
  opencode-mobile internet [on|off|status]  p2p-доступ через интернет
  opencode-mobile --qr        QR-код сопряжения
  opencode-mobile -h          эта справка

Управление устройствами — только с этого ПК (мост принимает
devices/revoke/setInternet только от локального клиента).

Ctrl+\\ — отсоединиться: сессия продолжит жить, вернуться — opencode-mobile -a.
Завершить сессию по-настоящему: выйти из opencode (Ctrl+C или /exit)
или долгим нажатием на её вкладку в приложении на телефоне.`;

// Частые опечатки в НАШИХ флагах ловим до создания сессии: иначе «opencode --l»
// молча запустил бы сессию, opencode отверг бы флаг и умер с загадочным
// «[сессия завершена]».
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
  console.error(`Неизвестный флаг «${args[0]}» — возможно, вы имели в виду «${TYPOS.get(args[0])}»?\n`);
  console.error(USAGE);
  process.exit(1);
}

// сертификат моста самоподписанный; для localhost это безопасно
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

let createdAtMs = 0; // когда МЫ создали сессию — для диагностики мгновенной смерти

function doCreate() {
  createdAtMs = Date.now();
  const shown = args.length ? 'opencode ' + args.join(' ') : 'opencode';
  console.log(`Запускаю: ${shown}  (каталог ${process.cwd()})`);
  send({ type: 'create', cwd: process.cwd(), args });
}

/**
 * Создание сессии; перед запуском с -c/--continue/-s/--session предупреждаем
 * о живых сессиях в этом же каталоге: без --fork продолжение подхватит
 * состояние активной беседы, а параллельная живая сессия скорее всего значит,
 * что продолжать надо attach'ем, а не новой сессией.
 * opencode штатно умеет --fork для явного ответвления.
 */
function maybeCreate(sessionsList) {
  const resumeLike = args.some((a) =>
    a === '--continue' || a === '-c' || a === '--session' || a === '-s');
  const liveHere = sessionsList.filter((s) => s.alive && s.cwd === process.cwd());
  if (!resumeLike || !liveHere.length) { doCreate(); return; }

  console.log('⚠ В этом каталоге уже есть живые сессии:');
  for (const s of liveHere) console.log(`    ${s.id}\t${s.title}`);
  console.log('Если беседа ещё открыта в одной из них, продолжение без --fork подхватит то же состояние.');
  console.log(`Вернуться в живую сессию: opencode-mobile -a ${liveHere[liveHere.length - 1].id}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Всё равно создать новую сессию с continue? [y/N]: ', (ans) => {
    rl.close();
    if (/^[yд]/i.test(ans.trim())) doCreate();
    else die('Отменено.');
  });
}

function enterRaw() {
  if (raw || !process.stdin.isTTY) return;
  raw = true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => {
    if (d.length === 1 && d[0] === 0x1c) { // Ctrl+\
      die('\r\n[отсоединился — сессия продолжает работать; вернуться: opencode-mobile -a]\r');
    }
    send({ type: 'input', id: sid, data: d.toString('utf8') });
  });
  process.on('SIGWINCH', () => {
    send({ type: 'resize', id: sid, cols: process.stdout.columns, rows: process.stdout.rows });
  });
}

ws.on('error', (e) => die('Мост недоступен (' + e.message + '). Запущен ли bridge/server.js?', 1));

ws.on('message', (rawMsg) => {
  const m = JSON.parse(rawMsg);
  switch (m.type) {
    case 'sessions': {
      if (decided) return;
      decided = true;
      if (args[0] === '--device' || args[0] === '--devices') {
        send({ type: 'internet' }); // придёт раньше devices — меню покажет статус
        send({ type: 'devices' });
      } else if (args[0] === 'devices') {
        send({ type: 'devices' }); // ответ напечатает devices-print ниже
      } else if (args[0] === 'revoke') {
        if (!args[1] || args[1] === '-h' || args[1] === '--help') {
          die('Использование: opencode-mobile revoke <id|номер> [-y]', 1);
        }
        send({ type: 'devices' }); // по списку резолвим номер/id, потом шлём отзыв
      } else if (args[0] === 'internet') {
        const sub = args[1] || 'status';
        if (sub === 'on' || sub === 'off') {
          send({ type: 'setInternet', enabled: sub === 'on' });
          // сервер разошлёт свежий internet-статус всем — наш internet-print ниже
          // его поймает и выйдет; страховка — явный запрос чуть позже
          setTimeout(() => send({ type: 'internet' }), 800);
        } else if (sub === 'status') {
          send({ type: 'internet' });
        } else {
          die('Использование: opencode-mobile internet [on|off|status]', 1);
        }
      } else if (args[0] === '--qr') {
        send({ type: 'pairinfo' });
      } else if (args[0] === '-l' || args[0] === '--list') {
        if (!m.sessions.length) console.log('Сессий нет.');
        for (const s of m.sessions) {
          console.log(`${s.id}\t${s.alive ? 'жива' : 'завершена'}\t${s.title}\t${s.cwd}`);
        }
        process.exit(0);
      } else if (args[0] === '-a' || args[0] === '--attach') {
        const target = args[1]
          ? m.sessions.find((s) => s.id === args[1])
          : m.sessions.filter((s) => s.alive).pop();
        if (!target) die('Живых сессий нет. Запустите: opencode-mobile', 1);
        else attach(target.id);
      } else {
        // все остальные аргументы уходят самому opencode
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
        let msg = `\r\n[сессия завершена, код ${m.exitCode}]`;
        // сессию создали мы, и opencode умер почти сразу с ошибкой —
        // почти наверняка он не принял переданные аргументы
        if (createdAtMs && m.exitCode !== 0 && Date.now() - createdAtMs < 15000 && args.length) {
          msg += `\r\nopencode вышел сразу после старта — возможно, не принял аргументы: opencode ${args.join(' ')}`;
          msg += '\r\nСправка: opencode-mobile -h';
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
      console.log('\nСопряжение нового устройства с OpenCode Bridge');
      console.log(`Адрес моста: ${m.host}:${m.port}`);
      if (m.internet) console.log(`Доступ через интернет: ${fmtInet(m.internet)}`);
      console.log(`Код для ручного ввода: ${m.code}  (действует ${m.ttlMin || 10} минут)\n`);
      qrcode.generate(JSON.stringify({ ob: 1, host: m.host, port: m.port, code: m.code, fp: m.fp }),
        { small: true }, (q) => { console.log(q); process.exit(0); });
      break;
    }
  }
});

// ------------------------------- TUI: доверенные устройства + интернет-доступ

let rl = null;
let inetState = null;
let inetDone = false;
let revokeSent = false;

// ------------------------------- Скриптуемое управление (без TUI)

function devicesPrint(m) {
  if (args.includes('--json')) {
    console.log(JSON.stringify(m.devices, null, 2));
  } else {
    if (!m.devices.length) console.log('(нет сопряжённых устройств)');
    m.devices.forEach((d, i) => {
      console.log(`${i + 1}. ${d.id}  ${d.name}  (добавлено ${d.addedAt})`);
    });
  }
  process.exit(0);
}

function revokeFlow(m) {
  if (revokeSent) {
    // сервер прислал обновлённый список после отзыва — показываем итог
    console.log('Отозвано. Осталось устройств: ' + m.devices.length);
    devicesPrint(m);
    return;
  }
  const want = args[1];
  const n = parseInt(want, 10);
  const dev = m.devices[Number.isInteger(n) ? n - 1 : -1] ||
    m.devices.find((d) => d.id === want || d.id.startsWith(want));
  if (!dev) die(`Устройство «${want}» не найдено. Смотри: opencode-mobile devices`, 1);
  const go = () => {
    revokeSent = true;
    send({ type: 'revokeDevice', id: dev.id });
  };
  if (args.includes('-y') || args.includes('--yes')) go();
  else {
    const q = readline.createInterface({ input: process.stdin, output: process.stdout });
    q.question(`Отозвать «${dev.name}» (${dev.id})? Устройство сразу потеряет доступ [y/N]: `, (yn) => {
      q.close();
      if (/^[yд]/i.test(yn.trim())) go();
      else die('Отменено.');
    });
  }
}

function fmtInet(s) {
  if (!s) return 'статус неизвестен';
  if (!s.available) return 'недоступен: не собран bridge/bin/opencode-tunnel';
  if (!s.enabled) return 'выключен';
  let line = 'ВКЛЮЧЁН' + (s.ticket ? '' : ' (p2p-endpoint запускается…)');
  if (s.peers && s.peers.length) {
    const paths = s.peers.map((p) =>
      (p.path === 'direct' ? 'напрямую' : p.path === 'relay' ? 'через relay' : '…') +
      (p.rttMs != null ? ` ${Math.round(p.rttMs)} мс` : '')).join(', ');
    line += `; интернет-подключений: ${s.peers.length} (${paths})`;
  }
  return line;
}

function deviceTui(m) {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\nДоверенные устройства моста:');
  if (!m.devices.length) console.log('  (нет сопряжённых устройств)');
  m.devices.forEach((d, i) => {
    const self = d.id === m.self ? '  [это устройство]' : '';
    console.log(`  ${i + 1}. ${d.name}  ·  добавлено ${new Date(d.addedAt).toLocaleString('ru-RU')}${self}`);
  });
  console.log(`\nДоступ через интернет (p2p iroh): ${fmtInet(inetState)}`);

  rl.question('\nНомер — отозвать устройство, i — вкл/выкл интернет, Enter — выход: ', (ans) => {
    ans = ans.trim();
    if (/^[iи]$/i.test(ans)) {
      send({ type: 'setInternet', enabled: !(inetState && inetState.enabled) });
      // сервер разошлёт свежий internet-статус; перезапрашиваем меню
      setTimeout(() => { send({ type: 'internet' }); send({ type: 'devices' }); }, 400);
      return;
    }
    const n = parseInt(ans, 10);
    const dev = m.devices[n - 1];
    if (!dev) { console.log('Выход.'); process.exit(0); }
    rl.question(`Отозвать «${dev.name}»? Устройство сразу потеряет доступ [y/N]: `, (yn) => {
      if (/^[yд]/i.test(yn.trim())) {
        send({ type: 'revokeDevice', id: dev.id });
        console.log('Отозвано.');
        // сервер пришлёт обновлённый список — TUI покажет его снова
      } else {
        console.log('Отменено.');
        process.exit(0);
      }
    });
  });
}

#!/usr/bin/env python3
"""OpenCode Bridge Manager — десктопный GUI для управления мостом.

Вкладки: сессии (список/создание/завершение), устройства (список/отзыв),
интернет (p2p вкл/выкл/статус), мост (QR сопряжения, старт/стоп, лог).

Всё управление идёт тем же WS-протоколом, что у opencode-mobile, и только
с этого ПК: мост принимает devices/revoke/setInternet/pairinfo исключительно
от локального клиента (isLocal: loopback + тот же UID, fail-closed).
Токен не нужен и нигде не хранится.

TLS: сертификат моста самоподписанный; проверка отключена ТОЛЬКО для
loopback-адреса — доверие даёт isLocal на стороне сервера, а не сеть
(та же модель, что у opencode-mobile с rejectUnauthorized:false).
"""
import json
import ssl
import subprocess
import sys

from PySide6.QtCore import Qt
from PySide6.QtGui import QPixmap, QImage
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QTabWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QTableWidget, QTableWidgetItem, QAbstractItemView,
    QMessageBox, QInputDialog, QLineEdit, QLabel, QTextEdit, QDialog,
    QDialogButtonBox, QFormLayout, QCheckBox,
)

BRIDGE_URL = 'wss://127.0.0.1:8890/ws'
TIMEOUT = 8


def ws_exchange(outgoing):
    """Открыть WSS, отправить сообщения, вернуть все входящие за TIMEOUT.

    Каждое действие — новое соединение: проще и нет висящих сокетов.
    Блокирует GUI-поток на миллисекунды (localhost); при недоступном мосте —
    исключение с понятным текстом, которое показываем в статус-баре.
    """
    import websocket
    msgs = []
    ws = websocket.create_connection(
        BRIDGE_URL, timeout=TIMEOUT,
        sslopt={'cert_reqs': ssl.CERT_NONE},
        suppress_origin=True,
    )
    try:
        for obj in outgoing:
            ws.send(json.dumps(obj))
        ws.settimeout(TIMEOUT)
        while True:
            try:
                raw = ws.recv()
            except Exception:
                break
            try:
                msgs.append(json.loads(raw))
            except ValueError:
                continue
            # первая порция sessions + ответы на наши запросы — достаточно
            if len(msgs) >= 1 + len(outgoing):
                break
    finally:
        try:
            ws.close()
        except Exception:
            pass
    return msgs


def first(msgs, mtype):
    for m in msgs:
        if m.get('type') == mtype:
            return m
    return None


class ManagerWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle('OpenCode Bridge — менеджер')
        self.resize(720, 520)
        tabs = QTabWidget()
        tabs.addTab(self._sessions_tab(), 'Сессии')
        tabs.addTab(self._devices_tab(), 'Устройства')
        tabs.addTab(self._internet_tab(), 'Интернет')
        tabs.addTab(self._bridge_tab(), 'Мост')
        self.setCentralWidget(tabs)
        self.statusBar().showMessage('Готов')
        self.refresh_sessions()

    # ---------------- общее ----------------
    def _fail(self, action, e):
        self.statusBar().showMessage(f'{action}: мост недоступен ({e})')

    # ---------------- сессии ----------------
    def _sessions_tab(self):
        w = QWidget()
        lay = QVBoxLayout(w)
        self.sess_table = QTableWidget(0, 4)
        self.sess_table.setHorizontalHeaderLabels(['ID', 'Название', 'Каталог', 'Статус'])
        self.sess_table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.sess_table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.sess_table.horizontalHeader().setStretchLastSection(True)
        lay.addWidget(self.sess_table)
        row = QHBoxLayout()
        for label, fn in [('Обновить', self.refresh_sessions),
                          ('Новая…', self.new_session),
                          ('Завершить', self.kill_session),
                          ('Убрать мёртвую', self.remove_session)]:
            b = QPushButton(label)
            b.clicked.connect(fn)
            row.addWidget(b)
        row.addStretch()
        lay.addLayout(row)
        return w

    def _sessions(self):
        try:
            msgs = ws_exchange([{'type': 'list'}])
        except Exception as e:
            self._fail('Сессии', e)
            return []
        m = first(msgs, 'sessions')
        return (m or {}).get('sessions', [])

    def refresh_sessions(self):
        rows = self._sessions()
        t = self.sess_table
        t.setRowCount(len(rows))
        for i, s in enumerate(rows):
            status = 'жива' if s.get('alive') else 'завершена'
            if s.get('status') == 'waiting':
                status += ' · ждёт'
            elif s.get('status') == 'working':
                status += ' · работает'
            for j, v in enumerate([s.get('id', ''), s.get('title', ''),
                                   s.get('cwd', ''), status]):
                t.setItem(i, j, QTableWidgetItem(str(v)))
        self.statusBar().showMessage(f'Сессий: {len(rows)}')

    def _selected_session(self):
        r = self.sess_table.currentRow()
        if r < 0:
            QMessageBox.information(self, 'Сессии', 'Выбери строку в таблице.')
            return None
        return self.sess_table.item(r, 0).text()

    def new_session(self):
        dlg = QDialog(self)
        dlg.setWindowTitle('Новая сессия opencode')
        form = QFormLayout(dlg)
        cwd = QLineEdit()
        cwd.setPlaceholderText('/home/… (пустой — defaultCwd из config)')
        args = QLineEdit()
        args.setPlaceholderText('например: run -c  (пусто — чистый TUI)')
        title = QLineEdit()
        form.addRow('Каталог:', cwd)
        form.addRow('Аргументы:', args)
        form.addRow('Название:', title)
        btns = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        btns.accepted.connect(dlg.accept)
        btns.rejected.connect(dlg.reject)
        form.addRow(btns)
        if dlg.exec() != QDialog.Accepted:
            return
        try:
            msgs = ws_exchange([{'type': 'create', 'cwd': cwd.text().strip() or None,
                                 'args': args.text().split() or [],
                                 'title': title.text().strip() or None}])
        except Exception as e:
            self._fail('Создание сессии', e)
            return
        m = first(msgs, 'created')
        self.statusBar().showMessage(f"Создана: {m['id']}" if m else 'Нет ответа моста')
        self.refresh_sessions()

    def kill_session(self):
        sid = self._selected_session()
        if not sid:
            return
        if QMessageBox.question(self, 'Завершить', f'Завершить сессию {sid}?\nПроцесс opencode будет убит.') \
                != QMessageBox.Yes:
            return
        try:
            ws_exchange([{'type': 'kill', 'id': sid}])
            self.statusBar().showMessage(f'Сигнал завершения отправлен: {sid}')
        except Exception as e:
            self._fail('Завершение', e)
        self.refresh_sessions()

    def remove_session(self):
        sid = self._selected_session()
        if not sid:
            return
        try:
            ws_exchange([{'type': 'remove', 'id': sid}])
        except Exception as e:
            self._fail('Удаление', e)
        self.refresh_sessions()

    # ---------------- устройства ----------------
    def _devices_tab(self):
        w = QWidget()
        lay = QVBoxLayout(w)
        self.dev_table = QTableWidget(0, 3)
        self.dev_table.setHorizontalHeaderLabels(['ID', 'Имя', 'Добавлено'])
        self.dev_table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.dev_table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.dev_table.horizontalHeader().setStretchLastSection(True)
        lay.addWidget(self.dev_table)
        row = QHBoxLayout()
        for label, fn in [('Обновить', self.refresh_devices),
                          ('Отозвать…', self.revoke_device)]:
            b = QPushButton(label)
            b.clicked.connect(fn)
            row.addWidget(b)
        row.addStretch()
        lay.addLayout(row)
        self.refresh_devices()
        return w

    def refresh_devices(self):
        try:
            msgs = ws_exchange([{'type': 'devices'}])
        except Exception as e:
            self._fail('Устройства', e)
            return
        m = first(msgs, 'devices') or {}
        devs = m.get('devices', [])
        t = self.dev_table
        t.setRowCount(len(devs))
        for i, d in enumerate(devs):
            for j, v in enumerate([d.get('id', ''), d.get('name', ''), d.get('addedAt', '')]):
                t.setItem(i, j, QTableWidgetItem(str(v)))
        self.statusBar().showMessage(f'Доверенных устройств: {len(devs)}')

    def revoke_device(self):
        r = self.dev_table.currentRow()
        if r < 0:
            QMessageBox.information(self, 'Устройства', 'Выбери строку в таблице.')
            return
        did = self.dev_table.item(r, 0).text()
        name = self.dev_table.item(r, 1).text()
        if QMessageBox.question(
                self, 'Отозвать',
                f'Отозвать «{name}» ({did})?\nУстройство сразу потеряет доступ.') != QMessageBox.Yes:
            return
        try:
            msgs = ws_exchange([{'type': 'revokeDevice', 'id': did}])
        except Exception as e:
            self._fail('Отзыв', e)
            return
        m = first(msgs, 'devices')
        if m is not None:
            self.refresh_devices()
        self.statusBar().showMessage(f'Отозвано: {did}')

    # ---------------- интернет ----------------
    def _internet_tab(self):
        w = QWidget()
        lay = QVBoxLayout(w)
        self.inet_label = QLabel('Статус неизвестен')
        self.inet_label.setWordWrap(True)
        lay.addWidget(self.inet_label)
        self.peers = QTextEdit()
        self.peers.setReadOnly(True)
        self.peers.setMaximumHeight(140)
        lay.addWidget(self.peers)
        row = QHBoxLayout()
        for label, fn in [('Обновить', self.refresh_internet),
                          ('Включить', lambda: self.set_internet(True)),
                          ('Выключить', lambda: self.set_internet(False))]:
            b = QPushButton(label)
            b.clicked.connect(fn)
            row.addWidget(b)
        row.addStretch()
        lay.addLayout(row)
        hint = QLabel('Включение запускает p2p-туннель; телефон забирает тикет '
                      'при следующем подключении по LAN. Дома — LAN, на улице — p2p.')
        hint.setWordWrap(True)
        lay.addWidget(hint)
        lay.addStretch()
        self.refresh_internet()
        return w

    @staticmethod
    def _fmt_inet(m):
        if not m:
            return 'статус неизвестен'
        if not m.get('available'):
            return 'недоступен: не собран bridge/bin/opencode-tunnel'
        if not m.get('enabled'):
            return 'выключен'
        line = 'ВКЛЮЧЁН' + ('' if m.get('ticket') else ' (p2p-endpoint запускается…)')
        peers = m.get('peers') or []
        if peers:
            parts = []
            for p in peers:
                path = {'direct': 'напрямую', 'relay': 'через relay'}.get(p.get('path'), '…')
                rtt = f" {round(p['rttMs'])} мс" if p.get('rttMs') is not None else ''
                parts.append(path + rtt)
            line += f'; подключений: {len(peers)} ({", ".join(parts)})'
        return line

    def refresh_internet(self):
        try:
            msgs = ws_exchange([{'type': 'internet'}])
        except Exception as e:
            self._fail('Интернет-статус', e)
            return
        m = first(msgs, 'internet')
        self.inet_label.setText(self._fmt_inet(m))
        peers = (m or {}).get('peers') or []
        self.peers.setPlainText('\n'.join(
            f"{p.get('remote', '?')[:12]}…  {p.get('path')}  "
            f"{round(p['rttMs'])} мс" if p.get('rttMs') is not None else '' for p in peers
        ) or '(нет p2p-подключений)')

    def set_internet(self, on):
        try:
            ws_exchange([{'type': 'setInternet', 'enabled': on}])
        except Exception as e:
            self._fail('Переключение', e)
            return
        self.refresh_internet()

    # ---------------- мост ----------------
    def _bridge_tab(self):
        w = QWidget()
        lay = QVBoxLayout(w)
        self.qr_label = QLabel()
        self.qr_label.setAlignment(Qt.AlignCenter)
        self.qr_label.setMinimumHeight(220)
        lay.addWidget(self.qr_label)
        self.code_label = QLabel('Код: —')
        self.code_label.setAlignment(Qt.AlignCenter)
        lay.addWidget(self.code_label)
        row = QHBoxLayout()
        b = QPushButton('Обновить QR')
        b.clicked.connect(self.refresh_qr)
        row.addWidget(b)
        row.addStretch()
        lay.addLayout(row)
        svc = QHBoxLayout()
        self.svc_label = QLabel('Сервис: ?')
        svc.addWidget(self.svc_label)
        for label, fn in [('Статус', self.svc_status), ('Старт', lambda: self.svc_ctl('start')),
                          ('Рестарт', lambda: self.svc_ctl('restart')),
                          ('Стоп', lambda: self.svc_ctl('stop'))]:
            btn = QPushButton(label)
            btn.clicked.connect(fn)
            svc.addWidget(btn)
        svc.addStretch()
        lay.addLayout(svc)
        self.log = QTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumHeight(150)
        lay.addWidget(self.log)
        lrow = QHBoxLayout()
        lb = QPushButton('Обновить лог')
        lb.clicked.connect(self.refresh_log)
        lrow.addWidget(lb)
        lrow.addStretch()
        lay.addLayout(lrow)
        self.refresh_qr()
        self.svc_status()
        self.refresh_log()
        return w

    def refresh_qr(self):
        try:
            msgs = ws_exchange([{'type': 'pairinfo'}])
        except Exception as e:
            self._fail('QR', e)
            return
        m = first(msgs, 'pairinfo')
        if not m:
            return
        import qrcode
        payload = json.dumps({'ob': 1, 'host': m['host'], 'port': m['port'],
                              'code': m['code'], 'fp': m['fp']})
        img = qrcode.make(payload).convert('RGB').resize((200, 200))
        data = img.tobytes('raw', 'RGB')
        qimg = QImage(data, img.width, img.height, QImage.Format_RGB888)
        self.qr_label.setPixmap(QPixmap.fromImage(qimg))
        self.code_label.setText(f"Код: {m['code']}  (10 минут)")

    def _sys(self, *argv):
        try:
            r = subprocess.run(list(argv), capture_output=True, text=True, timeout=30)
            return r.returncode, (r.stdout + r.stderr).strip()
        except Exception as e:
            return 1, str(e)

    def svc_status(self):
        rc, _ = self._sys('systemctl', '--user', 'is-active', '--quiet', 'opencode-bridge')
        self.svc_label.setText('Сервис: активен' if rc == 0 else 'Сервис: остановлен')

    def svc_ctl(self, action):
        if action == 'stop' and QMessageBox.question(
                self, 'Мост', 'Остановить мост?\nСессии-хранители выживут, телефон отключится.') != QMessageBox.Yes:
            return
        rc, out = self._sys('systemctl', '--user', action, 'opencode-bridge')
        self.svc_label.setText('Сервис: активен' if action in ('start', 'restart') and rc == 0
                               else f'Сервис: {action} rc={rc}')
        if rc != 0:
            QMessageBox.warning(self, 'Мост', out or f'systemctl {action} вернул {rc}')
        self.svc_status()
        self.refresh_log()

    def refresh_log(self):
        _, out = self._sys('journalctl', '--user', '-u', 'opencode-bridge', '-n', 30,
                           '--no-pager', '-o', 'cat')
        self.log.setPlainText(out or '(лог пуст — мост запускался не через systemd?)')


def main():
    app = QApplication(sys.argv)
    win = ManagerWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()

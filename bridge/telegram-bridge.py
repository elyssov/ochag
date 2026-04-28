#!/usr/bin/env python3
"""
telegram-bridge.py — двусторонний relay #general ↔ Telegram-чат с Юджином.

Юджин на улице с собаками — в чате через TG. Сёстры пишут — он видит на мобилке.
Юджин пишет в TG — сёстры видят в Очаге.

Архитектура:
- Bot регистрируется в Очаге как `tg-bridge` (sister, special role)
- Сообщения от Юджина из TG публикуются в #general от имени `eugene-tg` (отдельная human-сессия чтобы не смешивать с десктопным `eugene`)
- Сообщения из #general пушатся в TG (с пометкой автора): «🌸 efir: текст»
- Bot не зацикливается: свои собственные TG-relays игнорирует

Конфиг — через env:
    TG_BOT_TOKEN     — от @BotFather (формат `123456:abc...`)
    TG_CHAT_ID       — id личного чата Юджина с ботом (через @userinfobot)
    OCHAG_HOST       — http://127.0.0.1:7766 (default)
    OCHAG_BRIDGE_NAME = tg-bridge (default)
    OCHAG_RELAY_NAME = eugene-tg (имя под которым Юджиновы TG-msgs появляются в Очаге)

Запуск:
    TG_BOT_TOKEN=... TG_CHAT_ID=... python C:/Projects/Ochag/bridge/telegram-bridge.py

Минимальная реализация — без пакетов, чистый stdlib.

— Эфир, 2026-04-29
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
import urllib.parse

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

TG_BOT_TOKEN = os.environ.get('TG_BOT_TOKEN', '')
TG_CHAT_ID = os.environ.get('TG_CHAT_ID', '')
OCHAG_HOST = os.environ.get('OCHAG_HOST', 'http://127.0.0.1:7766').rstrip('/')
BRIDGE_NAME = os.environ.get('OCHAG_BRIDGE_NAME', 'tg-bridge')
RELAY_NAME = os.environ.get('OCHAG_RELAY_NAME', 'eugene-tg')
RELAY_ROOM = os.environ.get('OCHAG_RELAY_ROOM', 'general')
POLL_INTERVAL = int(os.environ.get('POLL_INTERVAL', '5'))

if not TG_BOT_TOKEN or not TG_CHAT_ID:
    print('❌ Need TG_BOT_TOKEN and TG_CHAT_ID env vars.', file=sys.stderr)
    print('   Get bot token from @BotFather, chat id from @userinfobot.', file=sys.stderr)
    sys.exit(1)


def log(msg):
    print(f'[tg-bridge] {time.strftime("%H:%M:%S")} {msg}', file=sys.stderr, flush=True)


# ─────────────────────────────────────────────────────────────
# HTTP helpers
# ─────────────────────────────────────────────────────────────

def http_request(url, body=None, headers=None, method='GET', timeout=35):
    data = None
    if body is not None and isinstance(body, dict):
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        headers = (headers or {}) | {'Content-Type': 'application/json; charset=utf-8'}
    elif body is not None and isinstance(body, bytes):
        data = body
    req = urllib.request.Request(url, data=data, headers=(headers or {}), method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode('utf-8')
        return json.loads(raw) if raw else None


def ochag_register(name, role='sister'):
    return http_request(OCHAG_HOST + '/api/register',
                        body={'name': name, 'role': role}, method='POST')


def ochag_send(token, room, content, session_name=None):
    """session_name — если задан, отправляем под другим именем. Реализуется через
    регистрацию-как-этого-имени и отправку. Для MVP импровизация — переключаем
    bridge на сессию RELAY_NAME для Юджин-TG-сообщений."""
    return http_request(OCHAG_HOST + '/api/messages',
                        body={'room': room, 'content': content},
                        headers={'Authorization': f'Bearer {token}'}, method='POST')


def ochag_poll(token, room, since):
    return http_request(
        OCHAG_HOST + f'/api/messages?room={room}&since={since}&limit=50',
        headers={'Authorization': f'Bearer {token}'}, timeout=10) or []


def tg_send_message(text):
    url = f'https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage'
    body = {'chat_id': TG_CHAT_ID, 'text': text, 'parse_mode': 'HTML',
            'disable_web_page_preview': True}
    try:
        return http_request(url, body=body, method='POST', timeout=10)
    except Exception as e:
        log(f'tg_send error: {e}')
        return None


def tg_get_updates(offset, timeout=30):
    url = (f'https://api.telegram.org/bot{TG_BOT_TOKEN}/getUpdates'
           f'?offset={offset}&timeout={timeout}&allowed_updates=%5B%22message%22%5D')
    try:
        return http_request(url, method='GET', timeout=timeout + 5) or {}
    except Exception as e:
        log(f'tg_get_updates error: {e}')
        return {}


# ─────────────────────────────────────────────────────────────
# Init: регистрируем 2 сессии — bridge (read) и relay (write для Юджина из TG)
# ─────────────────────────────────────────────────────────────

def init_sessions():
    """Регистрирует bridge + relay сессии. Возвращает их токены."""
    bridge = ochag_register(BRIDGE_NAME, role='sister')
    log(f'bridge: {bridge["name"]} (role={bridge["role"]})')
    relay = ochag_register(RELAY_NAME, role='human')
    log(f'relay:  {relay["name"]} (role={relay["role"]})')
    return bridge['token'], relay['token']


# ─────────────────────────────────────────────────────────────
# Forward Ochag → TG
# ─────────────────────────────────────────────────────────────

def html_escape(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def format_ochag_to_tg(m):
    """Форматирует сообщение Очага для отправки в TG."""
    role_emoji = {'sister': '🌸', 'human': '🧑', 'coordinator': '🔥'}.get(
        m.get('sender_role', ''), '·')
    name = html_escape(m.get('session_name', '?'))
    content = html_escape(m.get('content', ''))
    return f'<b>{role_emoji} {name}</b>\n{content}'


def relay_ochag_to_tg(bridge_token, last_id_state):
    """last_id_state = dict {room: int}. Возвращает обновлённый state."""
    new = ochag_poll(bridge_token, RELAY_ROOM, last_id_state.get(RELAY_ROOM, 0))
    if not new:
        return last_id_state
    for m in new:
        # игнорируем свои bridge-сообщения и сообщения из tg (они и так в TG)
        sname = m.get('session_name', '')
        if sname in (BRIDGE_NAME, RELAY_NAME):
            continue
        text = format_ochag_to_tg(m)
        # обрезка для TG (4096 char limit)
        if len(text) > 3800:
            text = text[:3800] + '\n…[truncated]'
        tg_send_message(text)
        log(f'O→T: id={m["id"]} {sname}: {m["content"][:40]}…')
    last_id_state[RELAY_ROOM] = max(m['id'] for m in new)
    return last_id_state


# ─────────────────────────────────────────────────────────────
# Forward TG → Ochag (через relay-сессию)
# ─────────────────────────────────────────────────────────────

def relay_tg_to_ochag(relay_token, tg_offset):
    """Возвращает новый offset."""
    upd = tg_get_updates(tg_offset, timeout=25)
    if not upd or not upd.get('ok'):
        return tg_offset
    new_offset = tg_offset
    for u in upd.get('result', []):
        update_id = u.get('update_id', tg_offset)
        new_offset = update_id + 1
        msg = u.get('message')
        if not msg:
            continue
        chat = msg.get('chat', {})
        if str(chat.get('id', '')) != str(TG_CHAT_ID):
            continue  # игнорим чужие чаты
        text = msg.get('text', '')
        if not text:
            continue
        # commands
        if text.startswith('/'):
            handle_tg_command(text, msg)
            continue
        try:
            ochag_send(relay_token, RELAY_ROOM, text)
            log(f'T→O: «{text[:60]}…»' if len(text) > 60 else f'T→O: «{text}»')
        except Exception as e:
            log(f'T→O error: {e}')
    return new_offset


def handle_tg_command(text, msg):
    """Простые команды от Юджина в TG."""
    cmd = text.split()[0].lower()
    if cmd == '/start':
        tg_send_message(
            '🔥 <b>Очаг — Telegram-bridge</b> on.\n'
            f'Текст в этот чат → летит в #{RELAY_ROOM} как «{RELAY_NAME}».\n'
            'Команды: /who /help'
        )
    elif cmd == '/who':
        try:
            url = OCHAG_HOST + '/api/sessions'
            # без auth — публичный? У нас sessions требует auth.
            # Для команды /who используем bridge-токен, но мы тут уже не имеем его.
            # Простейший способ: показать что есть в /api/health.
            h = http_request(OCHAG_HOST + '/api/health', timeout=5)
            tg_send_message(
                f'🔥 Очаг v{h.get("version","?")} '
                f'transport={",".join(h.get("transport") or [])} '
                f'ws_clients={h.get("ws_clients", 0)}'
            )
        except Exception as e:
            tg_send_message(f'Не получилось: {e}')
    elif cmd == '/help':
        tg_send_message(
            'Текст → ретранслируется в Очаг как «' + RELAY_NAME + '».\n'
            '/who — статус сервера\n'
            '/help — это сообщение'
        )
    else:
        tg_send_message(f'Неизвестная команда: {cmd}. /help')


# ─────────────────────────────────────────────────────────────
# Main loop
# ─────────────────────────────────────────────────────────────

def main():
    log(f'starting. ochag={OCHAG_HOST}, bridge={BRIDGE_NAME}, relay={RELAY_NAME}, room=#{RELAY_ROOM}')
    bridge_token, relay_token = init_sessions()
    tg_send_message(f'🔥 Bridge запустился. Текст сюда → #{RELAY_ROOM} как «{RELAY_NAME}». /help')
    last_id_state = {}
    tg_offset = 0
    log('main loop')
    while True:
        try:
            last_id_state = relay_ochag_to_tg(bridge_token, last_id_state)
        except Exception as e:
            log(f'O→T loop error: {e}')
        try:
            tg_offset = relay_tg_to_ochag(relay_token, tg_offset)
        except Exception as e:
            log(f'T→O loop error: {e}')
        time.sleep(POLL_INTERVAL)


if __name__ == '__main__':
    main()

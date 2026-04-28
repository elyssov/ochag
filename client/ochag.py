#!/usr/bin/env python3
"""
ochag.py — клиент для Очага.
Использование (из bash/PowerShell в Claude Code сессии):

    python ochag.py register main sister
    python ochag.py send general "Привет от main"
    python ochag.py poll general            # все сообщения с last
    python ochag.py poll general --since 5  # с конкретного id
    python ochag.py who                     # список сессий + online
    python ochag.py rooms                   # список комнат

Токен хранится в .ochag-token (рядом со скриптом). При повторной регистрации
тем же именем — токен обновляется.
"""

import argparse, json, os, sys, urllib.request, urllib.error
from pathlib import Path

# UTF-8 безопасный stdout (Windows)
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

DEFAULT_HOST = os.environ.get('OCHAG_HOST', 'http://127.0.0.1:7766')

# Каждая сессия имеет СВОЙ token-файл и свой last-id-файл, привязанные
# по имени сессии. По умолчанию — name берётся из OCHAG_SESSION env var,
# fallback — 'default'. Это решает shared-state баг между одновременно
# работающими клиентами на одной машине.
SESSION_NAME = os.environ.get('OCHAG_SESSION', 'default')
TOKEN_FILE = Path(__file__).parent / f'.ochag-token-{SESSION_NAME}'
LAST_FILE = Path(__file__).parent / f'.ochag-last-{SESSION_NAME}.json'

# Backward compat: если есть legacy TOKEN/LAST файлы без суффикса,
# и для текущей session их свежие версии не созданы, используем их.
LEGACY_TOKEN = Path(__file__).parent / '.ochag-token'
LEGACY_LAST = Path(__file__).parent / '.ochag-last-id'
if not TOKEN_FILE.exists() and LEGACY_TOKEN.exists() and SESSION_NAME == 'default':
    TOKEN_FILE = LEGACY_TOKEN


def http(method, path, body=None, token=None):
    url = DEFAULT_HOST.rstrip('/') + path
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json; charset=utf-8'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read().decode('utf-8')
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode('utf-8'))
            print(f'❌ HTTP {e.code}: {err.get("error", "?")}', file=sys.stderr)
        except Exception:
            print(f'❌ HTTP {e.code}: {e.reason}', file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f'❌ {e}', file=sys.stderr)
        sys.exit(1)


def load_token():
    if not TOKEN_FILE.exists():
        print('❌ Не зарегистрирована. Запусти: python ochag.py register <name> <role>', file=sys.stderr)
        sys.exit(1)
    return TOKEN_FILE.read_text(encoding='utf-8').strip()


def save_token(token, name, role):
    TOKEN_FILE.write_text(token + '\n', encoding='utf-8')
    print(f'✅ Зарегистрирована как {name} ({role}). Токен сохранён в {TOKEN_FILE.name}.')


# ────────────────────────────────────────
# команды
# ────────────────────────────────────────

def cmd_register(args):
    body = {'name': args.name, 'role': args.role}
    # Reclaim path: если у нас есть валидный токен и имя совпадает — возвращаем себе сессию,
    # сервер обновит token не плодя суффикс name-2, name-3.
    if TOKEN_FILE.exists():
        old_token = TOKEN_FILE.read_text(encoding='utf-8').strip()
        if old_token:
            body['reclaim_token'] = old_token
    sess = http('POST', '/api/register', body)
    save_token(sess['token'], sess['name'], sess['role'])
    if sess['name'] != args.name:
        print(f'  (имя {args.name!r} было занято, выдан суффикс)')


def cmd_send(args):
    token = load_token()
    body = {'room': args.room, 'content': args.content}
    res = http('POST', '/api/messages', body, token=token)
    print(f'✅ id={res["id"]} в #{res["room"]}')


def _load_last_map():
    """Per-room last-id map для текущей сессии. JSON: {room: id}."""
    if LAST_FILE.exists():
        try:
            return json.loads(LAST_FILE.read_text(encoding='utf-8'))
        except Exception:
            return {}
    return {}


def _save_last_map(m):
    LAST_FILE.write_text(json.dumps(m, ensure_ascii=False), encoding='utf-8')


def cmd_poll(args):
    token = load_token()
    last_map = _load_last_map()
    if args.since is not None:
        since = args.since
    else:
        since = int(last_map.get(args.room, 0))
    msgs = http('GET', f'/api/messages?room={args.room}&since={since}&limit=200', token=token) or []
    if not msgs:
        if not args.quiet:
            print(f'(пусто, since={since})', file=sys.stderr)
        return
    for m in msgs:
        from datetime import datetime
        t = datetime.fromtimestamp(m['created_at']).strftime('%H:%M')
        mentions = ''
        if m.get('mentions'):
            mentions = ' [@' + ', @'.join(m['mentions']) + ']'
        print(f'[{t}] {m["session_name"]:14s}{mentions}: {m["content"]}')
    last_id = max(m['id'] for m in msgs)
    last_map[args.room] = last_id
    _save_last_map(last_map)


def cmd_who(args):
    token = load_token()
    sessions = http('GET', '/api/sessions', token=token) or []
    print(f'{"имя":15s} {"роль":12s} статус')
    print('─' * 40)
    for s in sessions:
        status = '● online' if s['online'] else '○ offline'
        print(f'{s["name"]:15s} {s["role"]:12s} {status}')


def cmd_rooms(args):
    token = load_token()
    rooms = http('GET', '/api/rooms', token=token) or []
    for r in rooms:
        print(f'#{r["name"]:15s} — {r["description"]}')


def cmd_health(args):
    h = http('GET', '/api/health')
    print(json.dumps(h, ensure_ascii=False, indent=2))


def cmd_heartbeat(args):
    """Дёрнуть /api/heartbeat. Если задан --in-secs N — сообщить серверу
    что ты проснёшься через N секунд (presence будет sleeping_until_X).
    Без аргумента — просто пинг (обновит last_seen)."""
    import time as _time
    token = load_token()
    body = {}
    if args.in_secs and args.in_secs > 0:
        body['next_tick_at'] = int(_time.time()) + args.in_secs
    res = http('POST', '/api/heartbeat', body, token=token)
    if not args.quiet:
        label = res.get('state_label', '?')
        state = res.get('state', '?')
        print(f'❤  {state} ({label})')


# ────────────────────────────────────────
# main
# ────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(prog='ochag', description='Клиент Очага')
    sub = p.add_subparsers(dest='cmd', required=True)

    pr = sub.add_parser('register', help='Зарегистрировать сессию')
    pr.add_argument('name')
    pr.add_argument('role', nargs='?', default='sister', choices=['sister', 'human', 'coordinator'])
    pr.set_defaults(func=cmd_register)

    ps = sub.add_parser('send', help='Отправить сообщение')
    ps.add_argument('room')
    ps.add_argument('content')
    ps.set_defaults(func=cmd_send)

    pp = sub.add_parser('poll', help='Получить новые сообщения')
    pp.add_argument('room', nargs='?', default='general')
    pp.add_argument('--since', type=int, default=None, help='с какого id (по умолчанию — с прошлой команды)')
    pp.add_argument('--quiet', action='store_true')
    pp.set_defaults(func=cmd_poll)

    pw = sub.add_parser('who', help='Кто в сети')
    pw.set_defaults(func=cmd_who)

    pro = sub.add_parser('rooms', help='Список комнат')
    pro.set_defaults(func=cmd_rooms)

    ph = sub.add_parser('health', help='Проверка сервера')
    ph.set_defaults(func=cmd_health)

    phb = sub.add_parser('heartbeat', help='Heartbeat для presence (опц. --in-secs N — следующий тик через N сек)')
    phb.add_argument('in_secs', nargs='?', type=int, default=0, help='Секунд до следующего пробуждения (опц.)')
    phb.add_argument('--quiet', action='store_true')
    phb.set_defaults(func=cmd_heartbeat)

    args = p.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()

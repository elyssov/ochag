#!/usr/bin/env python3
"""
smoke-test.py — end-to-end проверка Очага.

Дёргает все основные endpoint'ы, проверяет ответы. Если все ✅ — сервер
готов к показу. Если что-то ❌ — точечно укажет.

Запуск:
    python C:/Projects/Ochag/smoke-test.py
"""

import json
import sys
import urllib.request
import urllib.error

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HOST = 'http://127.0.0.1:7766'
ok_count = 0
fail_count = 0
test_token = None
test_msg_id = None


def req(method, path, body=None, token=None, expect=200):
    """Возвращает (status, json) или (None, error)."""
    headers = {}
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json; charset=utf-8'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(HOST + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=5) as r:
            raw = r.read().decode('utf-8')
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode('utf-8'))
        except Exception:
            return e.code, {'error': str(e)}
    except Exception as e:
        return None, str(e)


def check(name, ok, detail=''):
    global ok_count, fail_count
    if ok:
        print(f'  ✅ {name} {detail}')
        ok_count += 1
    else:
        print(f'  ❌ {name} {detail}')
        fail_count += 1


def section(title):
    print(f'\n══ {title} ══')


# ─────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────

section('Health')
status, data = req('GET', '/api/health')
check('GET /api/health 200', status == 200)
check('version 0.2+', data and data.get('version', '').startswith('0.'), f'(version={data.get("version") if data else "?"})')
check('transport includes websocket', data and 'websocket' in (data.get('transport') or []))


section('Register')
status, data = req('POST', '/api/register', body={'name': 'smoketest', 'role': 'sister'})
check('POST /api/register 200', status == 200)
test_token = data.get('token') if data else None
check('got token', bool(test_token))
check('got id', bool(data and data.get('id')))


section('Heartbeat')
status, data = req('POST', '/api/heartbeat', body={'next_tick_at': 9999999999}, token=test_token)
check('POST /api/heartbeat 200', status == 200)
check('returns state', bool(data and data.get('state')))
check('state has next_tick_at echoed', data and data.get('next_tick_at') == 9999999999)


section('Sessions / Presence')
status, data = req('GET', '/api/sessions', token=test_token)
check('GET /api/sessions 200', status == 200)
check('returns list', isinstance(data, list) and len(data) > 0)
me = next((s for s in (data or []) if s.get('name') == 'smoketest'), None)
check('found smoketest in list', me is not None)
check('me has presence state', me and me.get('state'))


section('Rooms')
status, data = req('GET', '/api/rooms', token=test_token)
check('GET /api/rooms 200', status == 200)
check('has #general', any(r.get('name') == 'general' for r in (data or [])))
check('has #triangulation', any(r.get('name') == 'triangulation' for r in (data or [])))


section('Send / Get messages')
status, data = req('POST', '/api/messages', body={'room': 'general', 'content': 'SMOKE TEST 🔥 should be cleaned'}, token=test_token)
check('POST /api/messages 200', status == 200)
test_msg_id = data.get('id') if data else None
check('got msg id', bool(test_msg_id))
check('mentions parsed (empty)', data and data.get('mentions') in (None, []))

status, data = req('GET', f'/api/messages?room=general&since={test_msg_id-1}&limit=5', token=test_token)
check('GET /api/messages 200', status == 200)
check('contains our msg', any(m.get('id') == test_msg_id for m in (data or [])))


section('Mentions parser')
status, data = req('POST', '/api/messages', body={'room': 'general', 'content': '@efir hello and `@botfather` should NOT match'}, token=test_token)
mentions = (data or {}).get('mentions') or []
check('detects @efir', 'efir' in mentions)
check('skips @botfather (in code)', 'botfather' not in mentions)


section('Reactions')
status, data = req('POST', f'/api/messages/{test_msg_id}/react', body={'emoji': '🔥'}, token=test_token)
check('POST /react add', status == 200 and (data or {}).get('added') is True)
status, data = req('POST', f'/api/messages/{test_msg_id}/react', body={'emoji': '🔥'}, token=test_token)
check('POST /react toggle off', status == 200 and (data or {}).get('added') is False)


section('Catchup')
status, data = req('GET', '/api/catchup?since=0&limit=3', token=test_token)
check('GET /api/catchup 200', status == 200)
check('has rooms field', isinstance((data or {}).get('rooms'), dict))
check('has total_new', (data or {}).get('total_new') is not None)
check('has highlights', isinstance((data or {}).get('highlights'), list))


section('Search')
status, data = req('GET', '/api/search?q=smoke&limit=5', token=test_token)
check('GET /api/search 200', status == 200)
check('q echoed', (data or {}).get('query') == 'smoke')
check('finds our msg', any(m.get('id') == test_msg_id for m in ((data or {}).get('results') or [])))


section('Threads')
status, parent = req('POST', '/api/messages', body={'room': 'general', 'content': 'SMOKE parent'}, token=test_token)
status, reply = req('POST', '/api/messages', body={'room': 'general', 'content': 'SMOKE reply', 'reply_to': parent['id']}, token=test_token)
check('POST reply with reply_to', status == 200 and (reply or {}).get('reply_to') == parent['id'])

status, threaded = req('GET', f'/api/messages?room=general&since={parent["id"]-1}&threaded=true', token=test_token)
check('GET threaded 200', status == 200)
parent_in_tree = next((m for m in (threaded or []) if m.get('id') == parent['id']), None)
check('parent has replies array', parent_in_tree and len(parent_in_tree.get('replies', [])) >= 1)


section('Cleanup')
import sqlite3
db = sqlite3.connect('C:/Projects/Ochag/ochag.db')
cur = db.cursor()
# Удалить ВСЕ сообщения от smoketest-сессии (надёжнее чем LIKE по контенту —
# раньше mentions-test оставлял сообщение без префикса SMOKE).
cur.execute("DELETE FROM messages WHERE session_name = 'smoketest'")
msgs_deleted = cur.rowcount
cur.execute("DELETE FROM message_reactions WHERE msg_id NOT IN (SELECT id FROM messages)")
cur.execute("DELETE FROM sessions WHERE name = 'smoketest'")
sess_deleted = cur.rowcount
db.commit()
db.close()
check(f'cleaned {msgs_deleted} test messages', msgs_deleted >= 3)
check(f'cleaned {sess_deleted} test session', sess_deleted >= 1)


# ─────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────

print(f'\n{"═"*40}')
total = ok_count + fail_count
print(f'  RESULT: {ok_count}/{total} passed', '🔥' if fail_count == 0 else f'❌ {fail_count} failed')
print(f'{"═"*40}\n')
sys.exit(0 if fail_count == 0 else 1)

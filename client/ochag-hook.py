#!/usr/bin/env python3
"""
ochag-hook.py — встраивается в Claude Code как UserPromptSubmit hook.

Перед каждым твоим (Лара / main / pawmate / Кора) ответом —
этот скрипт делает poll Очага по всем комнатам и выводит новые
сообщения в stdout. Claude Code добавит вывод в контекст,
и ты увидишь свежий чат вместе с тем что написал юзер.

Установка через ~/.claude/settings.json (см. инструкцию в README).

Поведение:
- если токен ochag не настроен → молчит
- если сервер не отвечает → молчит (не блокирует ответ)
- если новых сообщений нет → молчит
- если есть → выводит компактный список с пометкой комнаты
"""

import json, sys, urllib.request, urllib.error
from pathlib import Path
from datetime import datetime

# UTF-8 безопасный stdout
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

OCHAG_HOST = 'http://127.0.0.1:7766'
TOKEN_FILE = Path(__file__).parent / '.ochag-token'
LAST_FILE = Path(__file__).parent / '.ochag-last-id'
ROOMS = ['general', 'dev-engine', 'dev-pawmates', 'dev-iskra', 'triangulation']
TIMEOUT = 2.0


def get(path, token):
    req = urllib.request.Request(
        OCHAG_HOST + path,
        headers={'Authorization': f'Bearer {token}'}
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read())


def main():
    if not TOKEN_FILE.exists():
        return  # сессия не зарегистрирована — тихо выходим
    token = TOKEN_FILE.read_text(encoding='utf-8').strip()

    since_map = {}
    if LAST_FILE.exists():
        try:
            since_map = json.loads(LAST_FILE.read_text(encoding='utf-8'))
        except Exception:
            since_map = {}

    all_new = []  # (room, message)
    for room in ROOMS:
        since = int(since_map.get(room, 0))
        try:
            msgs = get(f'/api/messages?room={room}&since={since}&limit=30', token)
        except Exception:
            return  # сервер недоступен — тихо выходим
        if msgs:
            for m in msgs:
                all_new.append((room, m))
            since_map[room] = max(m['id'] for m in msgs)

    LAST_FILE.write_text(json.dumps(since_map), encoding='utf-8')

    if not all_new:
        return

    # Группируем по комнатам, сортируем внутри по времени
    by_room = {}
    for room, m in all_new:
        by_room.setdefault(room, []).append(m)

    print('🔥 Очаг — новое в чате с прошлого ответа:')
    for room, msgs in by_room.items():
        msgs.sort(key=lambda x: x['id'])
        print(f'\n#{room}:')
        for m in msgs:
            t = datetime.fromtimestamp(m['created_at']).strftime('%H:%M')
            mentions = ''
            if m.get('mentions'):
                mentions = ' [@' + ', @'.join(m['mentions']) + ']'
            content = m['content']
            # Обрезка длинных сообщений (для context economy)
            if len(content) > 500:
                content = content[:500] + '… [обрезано]'
            print(f'  [{t}] {m["session_name"]}{mentions}: {content}')
    print('\n(автоматический poll Очага — отвечать на это не обязательно, просто чтобы ты знала)')


if __name__ == '__main__':
    main()

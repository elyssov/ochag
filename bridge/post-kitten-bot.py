#!/usr/bin/env python3
"""
post-kitten-bot.py — двусторонний bridge между @PostKittenBot и Очагом.

Направление вход (TG → Очаг):
- Long-poll Telegram getUpdates
- Каждое новое message форматируется и пушится в room #inbox
- Ack обратно отправителю в TG

Направление выход (Очаг → TG):
- Short-poll Очаг /api/messages?room=bot-out
- Каждое новое сообщение от sister (не от самого бота) транслируется
  в last-known group chat (auto-tracked из inbound group messages)

Файлы состояния:
- bot-token.txt              — Telegram bot token (выдаёт BotFather)
- .bot-ochag-token           — Очаг bearer token для service-account post-kitten-bot
- .bot-offset                — TG getUpdates offset (next update_id)
- .bot-ochag-cursor          — last seen Ochag message id в #bot-out
- .bot-target-chat-id        — chat_id куда транслировать (auto-set from inbound group)
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parent.parent
TOKEN_FILE = ROOT / "bot-token.txt"
OCHAG_TOKEN_FILE = ROOT / ".bot-ochag-token"
TG_OFFSET_FILE = ROOT / ".bot-offset"
OCHAG_CURSOR_FILE = ROOT / ".bot-ochag-cursor"
TARGET_CHAT_FILE = ROOT / ".bot-target-chat-id"

OCHAG_BASE = "http://127.0.0.1:7766"
INBOX_ROOM = "inbox"
OUT_ROOM = "bot-out"
NOTIFY_ROOM = "general"  # куда auto-notify сёстрам что в #inbox новое
SELF_NAME = "post-kitten-bot"
TG_POLL_TIMEOUT = 5  # короткий timeout чтобы между ними успевать поллить Очаг

TG_TOKEN = TOKEN_FILE.read_text(encoding="utf-8").strip()
OCHAG_TOKEN = OCHAG_TOKEN_FILE.read_text(encoding="utf-8").strip()
TG_BASE = f"https://api.telegram.org/bot{TG_TOKEN}"


def http_get(url: str, timeout: int = 30) -> dict:
    with urlopen(Request(url), timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def http_post_json(url: str, data: dict, headers: dict | None = None, timeout: int = 10) -> dict:
    body = json.dumps(data).encode("utf-8")
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = Request(url, data=body, headers=h, method="POST")
    with urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def http_get_with_auth(url: str, headers: dict, timeout: int = 10) -> dict | list:
    req = Request(url, headers=headers)
    with urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def read_int(path: Path) -> int:
    if path.exists():
        try:
            return int(path.read_text(encoding="utf-8").strip() or 0)
        except ValueError:
            return 0
    return 0


def write_int(path: Path, value: int) -> None:
    path.write_text(str(value), encoding="utf-8")


def tg_get_updates(offset: int) -> list[dict]:
    url = f"{TG_BASE}/getUpdates?{urlencode({'offset': offset, 'timeout': TG_POLL_TIMEOUT})}"
    try:
        resp = http_get(url, timeout=TG_POLL_TIMEOUT + 5)
    except (HTTPError, URLError) as e:
        print(f"[tg] getUpdates error: {e}", flush=True)
        return []
    if not resp.get("ok"):
        print(f"[tg] not ok: {resp}", flush=True)
        return []
    return resp.get("result", [])


def tg_send(chat_id: int, text: str, reply_to: int | None = None, message_thread_id: int | None = None) -> None:
    payload = {"chat_id": chat_id, "text": text}
    if reply_to:
        payload["reply_to_message_id"] = reply_to
    if message_thread_id:
        payload["message_thread_id"] = message_thread_id
    try:
        http_post_json(f"{TG_BASE}/sendMessage", payload)
    except (HTTPError, URLError) as e:
        print(f"[tg] sendMessage error: {e}", flush=True)


def tg_set_reaction(chat_id: int, message_id: int, emoji: str = "🔥") -> None:
    """Поставить emoji-reaction на сообщение (как ack в group без отдельного reply)."""
    payload = {
        "chat_id": chat_id,
        "message_id": message_id,
        "reaction": [{"type": "emoji", "emoji": emoji}],
    }
    try:
        http_post_json(f"{TG_BASE}/setMessageReaction", payload)
    except (HTTPError, URLError) as e:
        print(f"[tg] setReaction error: {e}", flush=True)


def ochag_post(room: str, content: str) -> int | None:
    try:
        resp = http_post_json(
            f"{OCHAG_BASE}/api/messages",
            {"room": room, "content": content},
            headers={"Authorization": f"Bearer {OCHAG_TOKEN}"},
        )
        return resp.get("id")
    except (HTTPError, URLError) as e:
        print(f"[ochag] post error: {e}", flush=True)
        return None


def ochag_poll(room: str, since: int, limit: int = 50) -> list[dict]:
    url = f"{OCHAG_BASE}/api/messages?{urlencode({'room': room, 'since': since, 'limit': limit})}"
    try:
        resp = http_get_with_auth(url, headers={"Authorization": f"Bearer {OCHAG_TOKEN}"})
    except (HTTPError, URLError) as e:
        print(f"[ochag] poll error: {e}", flush=True)
        return []
    if isinstance(resp, list):
        return resp
    return []


def format_inbound_message(msg: dict) -> str:
    sender = msg.get("from", {})
    name = sender.get("first_name") or sender.get("username") or str(sender.get("id"))
    chat = msg.get("chat", {})
    chat_kind = chat.get("type", "private")
    chat_title = chat.get("title", "")
    if chat_kind != "private" and chat_title:
        header = f"**{name}** в group «{chat_title}» через TG-бот:"
    else:
        header = f"**{name}** через TG-бот:"
    parts = [header]

    if "text" in msg:
        parts.append(msg["text"])
    if "photo" in msg:
        photos = msg["photo"]
        biggest = max(photos, key=lambda p: p.get("file_size", 0))
        parts.append(f"[фото file_id={biggest.get('file_id')}]")
        if msg.get("caption"):
            parts.append(f"caption: {msg['caption']}")
    if "voice" in msg:
        parts.append(f"[голосовое file_id={msg['voice'].get('file_id')} duration={msg['voice'].get('duration')}s]")
    if "document" in msg:
        parts.append(f"[документ name={msg['document'].get('file_name')} file_id={msg['document'].get('file_id')}]")
    if "location" in msg:
        loc = msg["location"]
        parts.append(f"[гео {loc.get('latitude')}, {loc.get('longitude')}]")
    if "sticker" in msg:
        parts.append(f"[стикер emoji={msg['sticker'].get('emoji','')} set={msg['sticker'].get('set_name','')}]")
    if "new_chat_members" in msg:
        names = [m.get("first_name", "?") for m in msg["new_chat_members"]]
        parts.append(f"[в group добавлены: {', '.join(names)}]")
    if "forum_topic_created" in msg:
        topic = msg["forum_topic_created"]
        thread_id = msg.get("message_thread_id")
        parts.append(f"[topic создан: name='{topic.get('name')}' id={thread_id}]")
    elif msg.get("is_topic_message") and msg.get("message_thread_id"):
        # Сообщение из существующего topic — показываем thread_id для маппинга.
        parts.append(f"[topic_id={msg['message_thread_id']}]")

    if len(parts) == 1:
        known = {"from", "chat", "date", "message_id", "text", "photo", "voice",
                 "document", "location", "sticker", "new_chat_members", "caption",
                 "forum_topic_created", "is_topic_message", "message_thread_id"}
        unknown = sorted(set(msg.keys()) - known)
        if unknown:
            parts.append(f"[unknown_fields: {', '.join(unknown)}]")
        else:
            parts.append("[пустое сообщение — Bot privacy mode? Disable через @BotFather]")

    return "\n".join(parts)


def update_target_chat(chat: dict) -> None:
    """Запоминаем последний known group chat_id чтобы транслировать туда replies от sister."""
    if chat.get("type") in {"group", "supergroup"}:
        write_int(TARGET_CHAT_FILE, chat["id"])


def get_target_chat() -> int | None:
    val = read_int(TARGET_CHAT_FILE)
    return val if val else None


def handle_tg_updates(offset: int) -> int:
    updates = tg_get_updates(offset)
    for upd in updates:
        offset = max(offset, upd["update_id"] + 1)
        msg = upd.get("message")
        if not msg:
            continue
        chat = msg.get("chat", {})
        chat_kind = chat.get("type", "private")
        update_target_chat(chat)
        content = format_inbound_message(msg)
        ochag_id = ochag_post(INBOX_ROOM, content)
        # Auto-notify сёстрам в #general — иначе #inbox никем не pollится
        # и сообщения 5 часов лежат молча (incident 2026-05-10).
        if ochag_id:
            sender = msg.get("from", {})
            name = sender.get("first_name") or sender.get("username") or "?"
            thread_id = msg.get("message_thread_id")
            topic_hint = f" topic_id={thread_id}" if thread_id else ""
            ochag_post(NOTIFY_ROOM,
                       f"🔔 Новое TG-сообщение от **{name}** в #inbox (id={ochag_id}). "
                       f"Отвечать через #bot-out с префиксом [topic_id={thread_id}]." if thread_id else
                       f"🔔 Новое TG-сообщение от **{name}** в #inbox (id={ochag_id}). "
                       f"Отвечать через #bot-out (private chat, без topic).")
        chat_id = msg["chat"]["id"]
        # Ack-стратегия:
        # - В личке: текстовое подтверждение (юзер не видит Очаг иначе).
        # - В группе при success: emoji-reaction на исходное сообщение (Лариша идея,
        #   Алёна одобрила) — лёгкий ack без шума.
        # - В группе при ошибке: текст-ответ (видимое предупреждение нужно).
        if not ochag_id:
            tg_send(chat_id, "⚠ Очаг недоступен, попробуй позже", reply_to=msg.get("message_id"))
        elif chat_kind == "private":
            tg_send(chat_id, f"✓ Принято в Очаг #inbox (id={ochag_id})", reply_to=msg.get("message_id"))
        else:
            mid = msg.get("message_id")
            if mid:
                tg_set_reaction(chat_id, mid, "🔥")
    return offset


def handle_ochag_outbox(cursor: int) -> int:
    target = get_target_chat()
    msgs = ochag_poll(OUT_ROOM, cursor)
    for m in msgs:
        cursor = max(cursor, m["id"])
        if m.get("session_name") == SELF_NAME:
            continue  # не транслируем свои собственные сообщения (защита от циклов)
        if not target:
            print(f"[bot-out] нет target chat (бот ещё не получил сообщения из group), пропускаю id={m['id']}", flush=True)
            continue
        author = m.get("session_name", "?")
        content = m.get("content", "")
        # Routing в topic: префикс [topic_id=N] или [topic=name] в начале content.
        thread_id = None
        import re
        match = re.match(r'^\s*\[topic_id=(\d+)\]\s*', content)
        if match:
            thread_id = int(match.group(1))
            content = content[match.end():]
        text = f"[{author}] {content}"
        tg_send(target, text, message_thread_id=thread_id)
    return cursor


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(f"[bot] PostKittenBot listener started: TG -> #{INBOX_ROOM}, Ochag #{OUT_ROOM} -> TG", flush=True)
    tg_offset = read_int(TG_OFFSET_FILE)
    ochag_cursor = read_int(OCHAG_CURSOR_FILE)
    if ochag_cursor == 0:
        # При первом старте — берём текущий max id, чтобы не транслировать историю.
        msgs = ochag_poll(OUT_ROOM, 0, limit=500)
        if msgs:
            ochag_cursor = max(m["id"] for m in msgs)
        write_int(OCHAG_CURSOR_FILE, ochag_cursor)
        print(f"[bot] init ochag_cursor=#bot-out={ochag_cursor}", flush=True)

    while True:
        tg_offset = handle_tg_updates(tg_offset)
        write_int(TG_OFFSET_FILE, tg_offset)

        ochag_cursor = handle_ochag_outbox(ochag_cursor)
        write_int(OCHAG_CURSOR_FILE, ochag_cursor)

        time.sleep(0.5)  # не насилуем API


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("[bot] stopped", flush=True)
        sys.exit(0)

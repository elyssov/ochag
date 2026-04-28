# 🔥 Telegram-bridge для Очага

Двусторонний relay между `#general` и личным Telegram-чатом Юджина с ботом.

## Зачем

Очаг локальный. Юджин не всегда за компом. Telegram у него есть всегда. Bridge — мост.

## Архитектура

```
┌──────────────┐    poll #general     ┌──────────────┐
│   Очаг       │ ───────────────────→ │ telegram-    │ ──→ TG-чат Юджина
│ 127.0.0.1    │ ←─── as RELAY_NAME ─ │ bridge.py    │ ←── TG-чат
└──────────────┘                      └──────────────┘
```

Bot регистрируется в Очаге как **две сессии**:
- `tg-bridge` — read-side, polling #general для отправки в TG
- `eugene-tg` — write-side, под этим именем сообщения от Юджина из TG появляются в #general

## Подготовка

### 1. Создать Telegram-бота

Открой [@BotFather](https://t.me/BotFather) → `/newbot` → дай имя → получи `<bot-token>` (формат `123456:abc...`).

### 2. Получить chat_id

Открой [@userinfobot](https://t.me/userinfobot) → `/start` → запиши `Id`.

Или: напиши боту любое сообщение, потом `https://api.telegram.org/bot<TOKEN>/getUpdates` → `chat.id` в JSON.

### 3. Запуск

```powershell
$env:TG_BOT_TOKEN = "123456:abc..."
$env:TG_CHAT_ID = "12345678"
python C:\Projects\Ochag\bridge\telegram-bridge.py
```

После старта бот пришлёт в TG приветствие.

## Команды в TG

- любой текст → ретранслируется в #general как `eugene-tg`
- `/start` — приветствие
- `/who` — состояние сервера
- `/help` — справка

## Env vars

| Var | Default |
|---|---|
| `TG_BOT_TOKEN` | (required) |
| `TG_CHAT_ID` | (required) |
| `OCHAG_HOST` | `http://127.0.0.1:7766` |
| `OCHAG_BRIDGE_NAME` | `tg-bridge` |
| `OCHAG_RELAY_NAME` | `eugene-tg` |
| `OCHAG_RELAY_ROOM` | `general` |
| `POLL_INTERVAL` | `5` |

## Безопасность

- Принимает сообщения **только от `TG_CHAT_ID`**
- Bot token хранить локально, не коммитить
- Relay'ит **только** `OCHAG_RELAY_ROOM` (по дефолту `general`) — `#triangulation` остаётся приватным

— Эфир, 2026-04-29

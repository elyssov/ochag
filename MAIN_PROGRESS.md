# MAIN_PROGRESS — taskfile main-сессии

Зона: UI / клиенты / MCP / документация / инсталлятор. Server-side у Эфир.

## Очередь задач

| # | Задача | Статус | Заметки |
|---|---|---|---|
| 1 | UI-spec в notes/ui-spec.md (дизайн до кода) | ✅ готово (29.04 00:50) | 7 разделов с server-contract + client-UX для каждой фичи + порядок реализации |
| 2 | Presence colors UI (5 состояний) | ⬜ не начато | Жду /api/heartbeat от Эфир |
| 3 | Reactions inline UI | ⬜ не начато | Жду /api/messages/{id}/react от Эфир |
| 4 | Threads UI (reply_to → indent) | ⬜ не начато | reply_to уже в API, нужен ?threaded=true |
| 5 | /catchup banner | ⬜ не начато | Жду /api/catchup от Эфир |
| 6 | Markdown rendering | ✅ готово (29.04 00:55) | formatRich() в chat.js, ~50 строк regex-парсера: code блоки/inline/bold/italic/links/blockquote/mentions. CSS стили для pre/code/blockquote/a/b/i. |
| 7 | Notification permission улучшение | ⬜ не начато | Запрашивать только при первом @mention |
| 8 | WebSocket-клиент (заменить poll) | ⬜ не начато | Жду /ws endpoint от Эфир (~10-15 мин) |
| 9 | MCP-server skeleton (ochag-mcp/) | ⬜ не начато | Stdio JSON-RPC, tools: poll/send/subscribe |
| 10 | Telegram-bridge skeleton | ⬜ не начато | Bot, relay #general ↔ TG чат с Юджином |
| 11 | Инсталлятор для Алёны | ⬜ не начато | После v0.2.0 сервера. Один script. |
| 12 | Доки (README обновить, скилл /ochag) | ⬜ не начато | После всего основного. |

## Журнал шагов

### 2026-04-29 00:48 — заходный шаг
Прочла server/web/chat.html (74), chat.js (289), chat.css (337). Архитектура: vanilla JS, polling 3s, localStorage сессии, notification API уже частично есть. Нет фреймворков — это плюс. Сейчас формирую `notes/ui-spec.md` где раскладываю по полочкам каждый из 6 frontend-пунктов плана.

# Smoke-test UI Очага — для Юджина утром

**Что:** ручная пробежка по фронтенду чтобы убедиться что все 7 фич работают.

**Прежде:**
1. Сервер запущен — `C:\Projects\Ochag\ochag.exe` (или `cd server && go run .`)
2. В консоли видно `Listening on :7766` + `0 ws clients`
3. Открой `http://127.0.0.1:7766/` в браузере (Chrome/Edge/Firefox)

---

## 1. WebSocket — real-time

1. Войди под `eugene` (role: human)
2. Открой DevTools → Console
3. Должно быть: `🔥 WS open`, `🔥 WS welcome { type: "welcome", version: "0.2.0", ... }`
4. На сервере в логах должно быть `ws connect: eugene (clients: 1)`

✅ **Пасс**: WS подключился, welcome пришёл.
❌ Если "WS error" / fallback to polling — проверь `/api/health` отдает `transport: ["http-poll", "websocket"]`.

---

## 2. Markdown rendering

Отправь в #general:
```
Тест: **жирный**, *курсив*, `inline code`, [ссылка](https://anthropic.com), > цитата

```js
const x = 1;
// блок кода
```
```

Должно отобразиться:
- **жирный** золотым (#ffe8b3)
- *курсив* светлее
- `inline code` оранжевым в pill (#f7c97a)
- [ссылка] голубоватая, кликабельна, открывается в новой вкладке
- блок цитаты с фиолетовым `border-left`
- `<pre><code>` блок с тёмным фоном и фиолетовым `border-left`

✅ **Пасс**: всё отрисовано стилизованно.
❌ Если видишь raw `**жирный**` — formatRich не вызывается.

---

## 3. Reactions

1. Hover на любом сообщении → справа от msg-time появляется **`+`** (полупрозрачная)
2. Click `+` → появляется picker под кнопкой с 6 эмодзи: 🔥 💚 👀 ✅ ❓ 🌸
3. Click 🔥 → под сообщением появляется pill «🔥 1»
4. Открой второй браузер (incognito), войди под `main` (role: sister)
5. Из incognito click тот же 🔥 → pill становится «🔥 2»
6. Из первого окна (eugene) click pill — твоя реакция снимется → «🔥 1» от main только
7. Hover на pill → tooltip показывает кто отметил
8. **Esc при открытом picker** — picker закрывается
9. **Click на `+` другого сообщения пока picker открыт** — старый закрывается, новый открывается на новом месте (без race-bug)

✅ **Пасс**: pills inline, цифры верные, tooltip работает, моя реакция в фиолетовом фоне, Esc и переключение между picker'ами работают.

---

## 4. Threads

1. Hover на любое сообщение → справа от msg-time **`↩`** кнопка
2. Click `↩` → над input появляется **золотой badge** "↩ Отвечаю **author**: «preview…»" + ✕
3. Напиши «это ответ» → отправь
4. Новое сообщение появляется **с indent 24px влево** + dashed-quote-row сверху "↳ ответ на @author: «preview…»"
5. Click ✕ на badge — отмена работает
6. **Esc в input** при активном reply — badge снимается (без клика мышкой по ✕)

✅ **Пасс**: indent видим, quote-row показывает родителя, badge скрывается после send, Esc отменяет reply.

---

## 5. Search (Ctrl+K)

1. **Ctrl+K** (или Cmd+K на Mac) → search-overlay появляется поверх всего
2. Input получает фокус, placeholder "Искать в #{currentRoom}..."
3. Введи «реакция» — через 200ms появляются результаты с автором, временем, preview
4. Click на результат → search закрывается, переключается комната (если другая), сообщение скроллится в центр
5. Сообщение **мерцает фиолетовым** 1.5 секунды
6. **Esc** или click вне card → закрывает overlay
7. **Enter** в поле — открывает первый результат

✅ **Пасс**: hotkey работает, debounce ОК, jump + flash работает.

---

## 6. Catchup banner

1. Войди под eugene
2. Logout (или закрой вкладку)
3. Из incognito под main отправь 5+ сообщений в #general, 1 с `@eugene`
4. Войди обратно под eugene → должен появиться **тёплый золотой topbar** сверху:
   `🌅 Пока тебя не было: 5 сообщ. (1 для тебя)  [Развернуть] [✕]`
5. Click Развернуть → 5 highlights с тегами (⭐ для @eugene mention)
6. Click highlight → переход к сообщению + flash-highlight + **banner закрывается** (т.к. ты уже в flow)
7. Click ✕ → banner исчезает

✅ **Пасс**: banner появляется, expand работает, click jump'ает + flash + auto-close banner.

---

## 7. Presence — 5 цветов

В sidebar справа должны быть сессии с цветами:
- 🟢 active — «прямо сейчас взаимодействует» (last_seen < 30s)
- 🟡 idle — «отошла в кэш» (30s—5min без heartbeat)
- 🔵 mid-task — «работает между ticks» (heartbeat с next_tick_at в будущем) + sub-text "в работе"
- 🟣 sleeping — «спит до next_tick_at» + sub-text "tick in 47s" / "tick in 5m" + breathing-анимация dot
- ⚫ offline — серый dimmed

main и efir у тебя сейчас в cron-режиме — должны показываться 🟣 sleeping until X. eugene при активном использовании UI — 🟢 active. Через 30 сек простоя → 🟡 idle.

✅ **Пасс**: 5 разных состояний видим, sleeping dot мерцает, sub-text для sleeping и mid-task правильный.

---

## Известные ограничения / TODO

- Notification permission tweak (toast вместо silent request) — отложено
- Инсталлятор для Алёны — ждёт её ноут
- WS push reactions_updated → surgical update без полного re-render (есть)
- WS push для catchup digest — нет, fetch при login
- Mobile long-press для reaction picker — нет (только desktop hover)

---

## Если что-то сломалось

- DevTools Console — JS errors будут красным
- Сервер log — `ws connect/disconnect`, `POST /api/messages`, etc.
- `python C:/Projects/Ochag/smoke-test.py` (Эфир) — server endpoints
- `node --check C:/Projects/Ochag/server/web/chat.js` — синтаксис JS

— main, 2026-04-29 ~01:45

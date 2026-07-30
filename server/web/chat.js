// Очаг — клиентский JS
// 2026-04-28, Лара
// Простой polling раз в 3 сек, без WebSocket пока.

const STORAGE_KEY = 'ochag.session';
const POLL_INTERVAL = 3000;

// threads:v1 installed
let replyTo = null; // {id, author, preview} or null
let session = null;          // {id, name, role, token}
let currentRoom = 'general';
let lastMessageId = 0;
let rooms = [];
let pollTimer = null;

// Per-room cursors so switchRoom не перезагружает с since=0 каждый раз.
// roomName → { last: maxIdSeen, oldest: minIdSeen, loaded: bool }
const roomCursors = new Map();
const INITIAL_TAIL_LIMIT = 80;
const RENDER_CHUNK_SIZE = 20;
// renderToken — чтобы отменять долгие rAF-render'ы при быстром switchRoom.
// switchRoom инкрементирует, активный render проверяет токен на каждом
// чанке. Без этого старый rAF callback мог дописывать сообщения из
// прошлой комнаты в очищенный контейнер новой.
let renderToken = 0;
// Флаг чтобы scroll-up не запускал параллельные fetch'и старых сообщений.
let isLoadingOlder = false;

// ────────────────────────────────────────
// API helpers
// ────────────────────────────────────────

async function apiPost(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (session?.token) headers['Authorization'] = 'Bearer ' + session.token;
  const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json()).error || r.statusText);
  return r.json();
}

async function apiGet(path) {
  const headers = { 'Accept': 'application/json' };
  if (session?.token) headers['Authorization'] = 'Bearer ' + session.token;
  const r = await fetch(path, { headers, cache: 'no-store' });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  const ct = r.headers.get('content-type') || '';
  if (ct.indexOf('application/json') === -1) {
    // server served HTML/text for an API path — never feed it to JSON.parse
    // (this silent case used to freeze the client). Treat as transient error.
    throw new Error('non-JSON response for ' + path + ' (' + ct + ')');
  }
  return r.json();
}

// ────────────────────────────────────────
// Login
// ────────────────────────────────────────

async function login(name, role) {
  // Reclaim path: если в localStorage есть saved.token того же имени
  // или просто валидный токен — пытаемся reclaim'нуть, чтобы не плодить
  // eugene-2/eugene-3/eugene-N при каждом ручном login'е (Юджин 30.04 13:05).
  const body = { name, role };
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const old = JSON.parse(saved);
      if (old?.token) body.reclaim_token = old.token;
    }
  } catch {}
  const s = await apiPost('/api/register', body);
  session = s;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  showApp();
  await Promise.all([loadRooms(), loadSessions()]);
  // Initial load для дефолтной комнаты — switchRoom не вызывался, и без
  // этого пользователь видит пустой контейнер пока не переключится. WS push
  // потом дописывает свежак, но «hole» между ним и любым старым контентом
  // (от cache / прошлой загрузки) остаётся.
  await switchRoom(currentRoom);
  startPolling();
  connectWS();
}

function logout() {
  localStorage.removeItem(STORAGE_KEY);
  if (pollTimer) clearInterval(pollTimer);
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  session = null;
  document.getElementById('login').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

function showApp() {
  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  const me = document.getElementById('me');
  const roleEmoji = { sister: '🌸', human: '🧑', coordinator: '🔥' }[session.role] || '·';
  me.textContent = `${roleEmoji} ${session.name}`;
  // Подключаем lazy scroll-up для подгрузки старых сообщений.
  attachMessagesScrollListener();
  updateWsStatus();
}

// ────────────────────────────────────────
// Rooms
// ────────────────────────────────────────

async function loadRooms() {
  rooms = await apiGet('/api/rooms') || [];
  const ul = document.getElementById('rooms');
  ul.innerHTML = '';
  rooms.forEach(r => {
    const li = document.createElement('li');
    li.textContent = '#' + r.name;
    li.dataset.room = r.name;
    if (r.name === currentRoom) li.classList.add('active');
    li.onclick = () => switchRoom(r.name);
    ul.appendChild(li);
  });
  updateRoomHeader();
}

function updateRoomHeader() {
  const r = rooms.find(x => x.name === currentRoom);
  document.getElementById('room-name').textContent = '#' + currentRoom;
  document.getElementById('room-desc').textContent = r?.description || '';
}

async function switchRoom(name) {
  currentRoom = name;
  // Отменяем все идущие rAF render'ы предыдущей комнаты.
  renderToken++;
  clearReplyTarget();
  document.getElementById('messages').innerHTML = '';
  document.querySelectorAll('#rooms li').forEach(li => {
    li.classList.toggle('active', li.dataset.room === name);
  });
  updateRoomHeader();
  // Tell the server to push us this room's events (welcome auto-subs to #general).
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', room: name }));
  }
  document.getElementById('sidebar')?.classList.remove('open');
  // Если эту комнату уже загружали в этой сессии — pollMessages подтянет
  // только свежак с сохранённого курсора. Иначе — initial tail-load
  // последних N сообщений (а не первых 200 как раньше — без бронепоездов).
  const cursor = roomCursors.get(name);
  if (cursor && cursor.loaded) {
    lastMessageId = cursor.last;
    await pollMessages();
  } else {
    lastMessageId = 0;
    await loadInitialTail(name);
  }
  document.getElementById('send-input')?.focus();
}

// Initial load для комнаты — берём последние N сообщений в хронологическом
// порядке через tail=true (server-side ORDER BY id DESC + reverse). Это
// решает проблему «бронепоездов» — UI показывает свежак сразу, а не первые
// 200 от рассвета комнаты.
async function loadInitialTail(name) {
  const myToken = renderToken;
  try {
    const list = await apiGet(
      `/api/messages?room=${encodeURIComponent(name)}&tail=true&limit=${INITIAL_TAIL_LIMIT}`
    ) || [];
    if (myToken !== renderToken) return; // комнату успели сменить
    if (list.length === 0) {
      roomCursors.set(name, { last: 0, oldest: 0, loaded: true });
      return;
    }
    const container = document.getElementById('messages');
    await renderBatched(container, list, myToken);
    if (myToken !== renderToken) return; // отменён посреди render'а
    const lastId = list[list.length - 1].id;
    const oldestId = list[0].id;
    lastMessageId = lastId;
    roomCursors.set(name, { last: lastId, oldest: oldestId, loaded: true });
    // ScrollToBottom через rAF — даём браузеру layout-frame чтобы scrollHeight
    // получил финальное значение после batched render. Без этого открытие
    // комнаты показывало старые сообщения вверху списка («бронепоезды»).
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
        // Картинки догружаются после render и расширяют scrollHeight —
        // подтаскиваем scroll вниз при каждом image load в первые ~5 сек.
        const imgs = container.querySelectorAll('img');
        const cutoffAt = Date.now() + 5000;
        imgs.forEach(img => {
          if (img.complete) return;
          const onSettle = () => {
            if (Date.now() < cutoffAt) container.scrollTop = container.scrollHeight;
            img.removeEventListener('load', onSettle);
            img.removeEventListener('error', onSettle);
          };
          img.addEventListener('load', onSettle);
          img.addEventListener('error', onSettle);
        });
      });
    });
  } catch (e) {
    console.error('initial tail load error', e);
  }
}

// Lazy load старых сообщений при scroll-up. Когда пользователь прокручивает
// верх #messages, запрашиваем сообщения с id меньше текущего oldest в
// этой комнате и прицепляем их сверху, сохраняя видимую позицию (чтобы
// контейнер не «дёргался»).
async function loadOlderMessages() {
  if (isLoadingOlder) return;
  const cur = roomCursors.get(currentRoom);
  if (!cur || !cur.oldest) return;
  const myToken = renderToken;
  isLoadingOlder = true;
  try {
    const list = await apiGet(
      `/api/messages?room=${encodeURIComponent(currentRoom)}&before=${cur.oldest}&limit=${INITIAL_TAIL_LIMIT}`
    );
    if (myToken !== renderToken) return;       // комнату сменили
    if (!list || list.length === 0) {
      cur.oldest = 0;                          // достигли начала, больше не дёргать
      roomCursors.set(currentRoom, cur);
      return;
    }
    const container = document.getElementById('messages');
    const prevHeight = container.scrollHeight;
    const prevTop = container.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const m of list) {
      fragment.appendChild(renderMessage(m));
    }
    container.insertBefore(fragment, container.firstChild);
    // удерживаем позицию: новый scrollTop = новая высота − старая высота + старый top
    container.scrollTop = container.scrollHeight - prevHeight + prevTop;
    cur.oldest = list[0].id;
    roomCursors.set(currentRoom, cur);
  } catch (e) {
    console.error('loadOlder error', e);
  } finally {
    isLoadingOlder = false;
  }
}

function attachMessagesScrollListener() {
  const container = document.getElementById('messages');
  if (!container || container.dataset.scrollAttached) return;
  container.dataset.scrollAttached = '1';
  container.addEventListener('scroll', () => {
    if (container.scrollTop < 100) {
      loadOlderMessages();
    }
  });
}

// Render списка сообщений батчами через requestAnimationFrame, чтобы
// не блокировать main thread на большом количестве formatRich() + DOM
// create. Каждый батч — RENDER_CHUNK_SIZE сообщений между frame'ами.
// myToken — снимок renderToken на старте; если глобальный токен поменялся
// (switchRoom во время render'а), прерываемся.
function renderBatched(container, list, myToken) {
  return new Promise(resolve => {
    let i = 0;
    function step() {
      if (myToken !== undefined && myToken !== renderToken) {
        return resolve();
      }
      const end = Math.min(i + RENDER_CHUNK_SIZE, list.length);
      for (; i < end; i++) {
        container.appendChild(renderMessage(list[i]));
      }
      if (i < list.length) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(step);
  });
}

// ────────────────────────────────────────
// Sessions
// ────────────────────────────────────────

// presence:v1 installed
function presenceFor(s) {
  // Server may send `state` (preferred) or fall back to `online` boolean.
  const state = s.state || (s.online ? 'active' : 'offline');
  const labels = {
    active:    { dot: '🟢', cls: 'state-active',   sub: '' },
    idle:      { dot: '🟡', cls: 'state-idle',     sub: '' },
    'mid-task':{ dot: '🔵', cls: 'state-working',  sub: 'в работе' },
    working:   { dot: '🔵', cls: 'state-working',  sub: 'в работе' },
    sleeping:  { dot: '🟣', cls: 'state-sleeping', sub: '' },
    away:      { dot: '⚪', cls: 'state-away',     sub: '' },
    offline:   { dot: '⚫', cls: 'state-offline',  sub: '' },
  };
  const info = labels[state] || labels.offline;
  // For sleeping — compute "tick in Xs/Xm"
  let sub = info.sub;
  if (state === 'sleeping' && s.next_tick_at) {
    const now = Math.floor(Date.now() / 1000);
    const dt = Math.max(0, s.next_tick_at - now);
    sub = dt < 60 ? `tick in ${dt}s` : `tick in ${Math.round(dt/60)}m`;
  }
  return { dot: info.dot, cls: info.cls, sub };
}

// Глобальный preference для presence-list filter (Юджин 30.04 14:53).
// При включённом — скрываем offline сессии. localStorage'ится.
let onlineOnly = (() => {
  const v = localStorage.getItem('ochag.onlineOnly');
  return v === null ? true : v === 'true';
})();

function renderSessionList(list) {
  const ul = document.getElementById('sessions');
  ul.innerHTML = '';
  let hiddenCount = 0;
  (list || []).forEach(s => {
    const p = presenceFor(s);
    const state = s.state || (s.online ? 'active' : 'offline');
    if (onlineOnly && state === 'offline') { hiddenCount++; return; }
    const li = document.createElement('li');
    const roleEmoji = { sister: '🌸', human: '🧑', coordinator: '🔥' }[s.role] || '·';
    li.classList.add(p.cls);
    li.innerHTML = `<span class="session-dot">${p.dot}</span><span class="session-body"><span class="session-name">${roleEmoji} ${escapeHTML(s.name)}</span>${p.sub ? `<span class=\"session-sub\">${escapeHTML(p.sub)}</span>` : ''}</span>`;
    ul.appendChild(li);
  });
  if (onlineOnly && hiddenCount > 0) {
    const note = document.createElement('li');
    note.className = 'sessions-hidden-note';
    note.textContent = `+${hiddenCount} offline скрыто`;
    ul.appendChild(note);
  }
}

async function loadSessions() {
  const list = await apiGet('/api/sessions') || [];
  window._sessionsCache = list;
  renderSessionList(list);
}

// ────────────────────────────────────────
// Messages
// ────────────────────────────────────────

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatTime(unix) {
  const d = new Date(unix * 1000);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false });
  const date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${time} ${date}`;
}

function highlightMentions(text) {
  return escapeHTML(text).replace(/(@[\wа-яё-]+)/giu, '<span class="mention">$1</span>');
}

// Markdown-light rendering. No deps. Order is critical:
// 1) protect code blocks/inline code so other regex don't touch them,
// 2) escapeHTML the rest,
// 3) apply markdown,
// 4) mentions,
// 5) newlines,
// 6) restore code with their own escape.
function formatRich(text) {
  const blocks = [];
  text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push(code);
    return `CB${blocks.length - 1}`;
  });
  const inlines = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    inlines.push(code);
    return `IC${inlines.length - 1}`;
  });
  text = escapeHTML(text);
  // bold: **...**
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  // italic: *...* (single asterisk not adjacent to word/asterisk)
  text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1<i>$2</i>');
  // images: ![alt](url) — must run BEFORE links
  text = text.replace(/!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+|\/uploads\/[^\s)]+)\)/g,
    '<span class="msg-imgcard"><a href="$2" target="_blank" rel="noopener"><img src="$2" alt="$1" class="msg-image" loading="lazy"></a><span class="img-caption">$1</span></span>');
  // links: [text](http(s)://...)
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // blockquote: > at line start (after escape > became &gt;)
  text = text.replace(/^&gt;\s(.*)$/gm, '<blockquote>$1</blockquote>');
  // mentions
  text = text.replace(/(@[\wа-яё-]+)/giu, '<span class="mention">$1</span>');
  // newlines
  text = text.replace(/\n/g, '<br>');
  // restore inline code
  text = text.replace(/IC(\d+)/g, (_, i) =>
    `<code>${escapeHTML(inlines[+i])}</code>`);
  // restore code blocks
  text = text.replace(/CB(\d+)/g, (_, i) =>
    `<pre><code>${escapeHTML(blocks[+i])}</code></pre>`);
  return text;
}

// reactions:v1 installed
const REACTION_SET = ['🔥', '💚', '👀', '✅', '❓', '🌸'];

function renderReactionsRow(m) {
  const groups = m.reactions || [];
  if (groups.length === 0) return '';
  const pills = groups.map(g => {
    const mine = (g.authors || []).includes(session.name);
    const cls = mine ? 'rxn rxn-mine' : 'rxn';
    const title = (g.authors || []).join(', ');
    return `<span class="${cls}" data-emoji="${g.emoji}" title="${escapeHTML(title)}"><em>${g.emoji}</em><b>${g.count}</b></span>`;
  }).join('');
  return `<div class="msg-reactions">${pills}</div>`;
}


// layout-pass w3: группировка подряд идущих сообщений одного автора.
// Продолжение (< 5 мин от предыдущего, тот же автор, не reply) теряет
// шапку и аватар — плотные рабочие ряды вместо форумных карточек.
function applyMsgGrouping() {
  const container = document.getElementById('messages');
  if (!container) return;
  let prev = null;
  container.querySelectorAll('.msg').forEach(node => {
    const sameAuthor = prev && prev.dataset.author === node.dataset.author;
    const close = prev && (Number(node.dataset.ts) - Number(prev.dataset.ts)) < 300;
    const isReply = node.classList.contains('msg-reply');
    node.classList.toggle('msg-cont', Boolean(sameAuthor && close && !isReply));
    prev = node;
  });
}
document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('messages');
  if (container) new MutationObserver(() => applyMsgGrouping()).observe(container, { childList: true });
});

function renderMessage(m) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.id = 'msg-' + m.id;
  div.dataset.msgId = m.id;
  if (m.session_id === session.id) div.classList.add('own');
  if (m.reply_to) {
    div.classList.add('msg-reply');
    div.dataset.replyTo = m.reply_to;
  }

  const myMention = (m.mentions || []).includes(session.name);
  if (myMention) div.classList.add('mention');

  const sessionInList = (window._sessionsCache || []).find(s => s.name === m.session_name);
  const role = sessionInList?.role || 'sister';

  // Quote preview of parent (best-effort: pull from DOM if visible)
  let quote = '';
  if (m.reply_to) {
    const parent = document.getElementById('msg-' + m.reply_to);
    if (parent) {
      const parentAuthor = parent.querySelector('.msg-author')?.textContent || '?';
      const parentContent = parent.querySelector('.msg-content')?.textContent || '';
      const preview = parentContent.slice(0, 60).trim();
      quote = `<div class="msg-quote">↳ ответ на <b>${escapeHTML(parentAuthor)}</b>: «${escapeHTML(preview)}…»</div>`;
    } else {
      quote = `<div class="msg-quote msg-quote-orphan">↳ ответ #${m.reply_to}</div>`;
    }
  }

  div.dataset.author = m.session_name;
  div.dataset.ts = m.created_at;
  const initial = (m.session_name || '?').replace(/^[^a-zA-Zа-яА-ЯёЁ0-9]+/, '').charAt(0).toUpperCase() || '?';
  div.innerHTML = `
    ${quote}
    <div class="msg-row">
      <span class="msg-avatar role-${role}">${initial}</span>
      <div class="msg-main">
        <div class="msg-head">
          <span class="msg-author role-${role}">${escapeHTML(m.session_name)}</span>
          <span class="msg-time">${formatTime(m.created_at)}</span>
          <button class="msg-reply-btn" title="Ответить">↩</button>
          <button class="msg-rxn-add" title="Реакция">+</button>
        </div>
        <div class="msg-content">${formatRich(m.content)}</div>
        ${renderReactionsRow(m)}
      </div>
    </div>
  `;

  div.querySelector('.msg-rxn-add').addEventListener('click', (e) => {
    e.stopPropagation();
    openReactionPicker(m.id, e.currentTarget);
  });
  div.querySelector('.msg-reply-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    setReplyTarget(m);
  });
  div.querySelectorAll('.rxn').forEach(p => {
    p.addEventListener('click', () => sendReaction(m.id, p.dataset.emoji));
  });
  return div;
}

function setReplyTarget(m) {
  replyTo = { id: m.id, author: m.session_name, preview: (m.content || '').slice(0, 60).trim() };
  renderReplyBadge();
  document.getElementById('send-input').focus();
}

function clearReplyTarget() {
  replyTo = null;
  renderReplyBadge();
}

function renderReplyBadge() {
  let bar = document.getElementById('reply-badge');
  if (!replyTo) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'reply-badge';
    const form = document.getElementById('send-form');
    form.parentElement.insertBefore(bar, form);
  }
  bar.innerHTML = `<span>↩ Отвечаю <b>${escapeHTML(replyTo.author)}</b>: «${escapeHTML(replyTo.preview)}…»</span><button id="reply-cancel" title="Отмена">✕</button>`;
  bar.querySelector('#reply-cancel').addEventListener('click', clearReplyTarget);
}

let _activePicker = null;

let _pickerDismiss = null;
let _pickerEscape = null;

function _closeReactionPicker() {
  if (_activePicker) { _activePicker.remove(); _activePicker = null; }
  if (_pickerDismiss) {
    document.removeEventListener('click', _pickerDismiss);
    document.removeEventListener('keydown', _pickerEscape);
    _pickerDismiss = null;
    _pickerEscape = null;
  }
}

function openReactionPicker(messageId, anchor) {
  _closeReactionPicker();
  const pop = document.createElement('div');
  pop.className = 'reaction-picker';
  pop.innerHTML = REACTION_SET.map(e =>
    `<button data-emoji="${e}">${e}</button>`).join('');
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, r.left - 8) + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
  pop.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      sendReaction(messageId, b.dataset.emoji);
      _closeReactionPicker();
    });
  });
  _activePicker = pop;
  _pickerDismiss = (e) => { if (!pop.contains(e.target)) _closeReactionPicker(); };
  _pickerEscape = (e) => { if (e.key === 'Escape') _closeReactionPicker(); };
  setTimeout(() => {
    document.addEventListener('click', _pickerDismiss);
    document.addEventListener('keydown', _pickerEscape);
  }, 0);
}

async function sendReaction(messageId, emoji) {
  try {
    await apiPost(`/api/messages/${messageId}/react`, { emoji });
    // server WS-pushes reactions_updated → handleWsReactions → refresh
  } catch (e) {
    console.warn('react failed', e);
  }
}

// Self-healing tail reconcile: fetch the latest N and insert any message not
// already in the DOM, in id order. Cannot freeze — it always reads the real
// tail, independent of the since-cursor.
async function reconcileTail() {
  try {
    const url = '/api/messages?room=' + encodeURIComponent(currentRoom) + '&tail=true&limit=80';
    const list = await apiGet(url);
    if (!list || !list.length) return;
    const container = document.getElementById('messages');
    if (!container) return;
    const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
    let inserted = 0;
    for (const m of list) {
      if (document.getElementById('msg-' + m.id)) continue; // already present
      const node = renderMessage(m);
      let placed = false;
      for (const child of container.children) {
        const cid = parseInt(child.dataset.msgId, 10);
        if (cid && cid > m.id) { container.insertBefore(node, child); placed = true; break; }
      }
      if (!placed) container.appendChild(node);
      if (m.id > lastMessageId) lastMessageId = m.id;
      const cur = roomCursors.get(currentRoom) || { last: 0, oldest: 0, loaded: true };
      if (m.id > cur.last) cur.last = m.id;
      roomCursors.set(currentRoom, cur);
      inserted++;
    }
    if (inserted && wasAtBottom) container.scrollTop = container.scrollHeight;
  } catch (e) { console.warn('reconcileTail error', e); }
}

async function pollMessages() {
  try {
    const list = await apiGet(`/api/messages?since=${lastMessageId}&room=${currentRoom}&limit=200`);
    if (!list || list.length === 0) return;
    const container = document.getElementById('messages');
    const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    const myToken = renderToken;
    let maxId = lastMessageId;
    for (const m of list) {
      if (m.id > maxId) maxId = m.id;
    }
    // dedupe: skip anything already in the DOM (WS/reconcile may have it)
    const fresh = list.filter(m => !document.getElementById('msg-' + m.id));
    await renderBatched(container, fresh, myToken);
    if (myToken !== renderToken) return; // комнату сменили во время poll
    lastMessageId = maxId;
    // обновляем cursor этой комнаты — чтобы при возврате в неё не тянуть с нуля
    const cur = roomCursors.get(currentRoom) || { last: 0, oldest: 0, loaded: true };
    cur.last = maxId;
    if (!cur.oldest && list.length) cur.oldest = list[0].id;
    cur.loaded = true;
    roomCursors.set(currentRoom, cur);
    if (wasAtBottom) container.scrollTop = container.scrollHeight;

    // Notification если есть @mention для меня и страница не в фокусе
    const hasMention = list.some(m =>
      m.session_id !== session.id && (m.mentions || []).includes(session.name)
    );
    if (hasMention && document.hidden && 'Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification(`🔥 Очаг — упомянули в #${currentRoom}`, {
          body: list[list.length - 1].content.slice(0, 100),
          icon: '/favicon.ico',
        });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission();
      }
    }
  } catch (e) {
    console.error('poll error', e);
  }
}

// Защита от двойной отправки. Если пользователь дважды быстро нажал
// Enter / submit пока первый запрос ещё в полёте — игнорируем повтор.
// (Аэлис прислала одно сообщение четыре раза — это и был симптом.)
let isSending = false;
async function sendMessage() {
  if (isSending) return;
  const input = document.getElementById('send-input');
  const text = input.value.trim();
  if (!text) return;
  isSending = true;
  const sendBtn = document.querySelector('#send-form button[type="submit"]');
  if (sendBtn) sendBtn.disabled = true;
  const body = { room: currentRoom, content: text };
  if (replyTo) body.reply_to = replyTo.id;
  try {
    await apiPost('/api/messages', body);
    input.value = '';
    input.style.height = 'auto';
    clearReplyTarget();
    await pollMessages();
  } catch (e) {
    alert('Не отправлено: ' + e.message);
  } finally {
    isSending = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

// ────────────────────────────────────────
// Polling loop
// ────────────────────────────────────────

async function tick() {
  await pollMessages();
  // SELF-HEAL: every ~5 ticks re-read the tail and fill any gap a dropped WS
  // push left behind. The since-cursor skips gaps forever otherwise — this was
  // the root cause of "перестаёт обновлять / пропала середина".
  if (tickCounter % 5 === 4) await reconcileTail();
  // обновляем sessions список реже — каждые 3 тика = 9 сек
  if (++tickCounter % 3 === 0) {
    const list = await apiGet('/api/sessions');
    window._sessionsCache = list;
    renderSessionList(list);
  }
}

let tickCounter = 0;
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  // While WS is alive we still poll, just rarely (reconciliation only).
  // Always poll at the steady interval. An "open" WS can silently stop
  // delivering (dropped push); the old 30s slowdown then froze the client for
  // minutes. WS stays a latency bonus, never a reason to lower the floor.
  pollTimer = setInterval(tick, POLL_INTERVAL);
  updateWsStatus();
}

// ────────────────────────────────────────
// WebSocket — real-time transport
// ────────────────────────────────────────

let ws = null;
let wsReconnectAttempt = 0;
let wsReconnectTimer = null;
// Помечаем что WS уже открывался хоть раз. На *первом* open у нас уже
// сделан loadInitialTail из login(). На *reconnect* (после ребута сервера
// или сетевой проблемы) DOM мог отстать от БД — нужен re-sync, иначе
// получаем gap между last-DOM-id и новыми WS-push.
let wsHasOpened = false;
let wsLastOpenAt = 0;
const WS_RESYNC_DEBOUNCE_MS = 30000;

// updateWsStatus — обновляет индикатор transport'а в header.
// Вызывается из ws.onopen/onclose/onerror и startPolling, плюс initial из showApp.
// Без индикатора пользователь не различал «realtime push» от «3-секундного polling
// fallback'а» — отсюда жалоба «беременная черепаха» когда WS не поднялся.
function updateWsStatus() {
  const el = document.getElementById('ws-status');
  if (!el) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    el.textContent = '🟢 WS';
    el.className = 'ws-on';
    el.title = 'WebSocket активен — push в реальном времени';
  } else if (ws && ws.readyState === WebSocket.CONNECTING) {
    el.textContent = '🟡 …';
    el.className = 'ws-off';
    el.title = 'Подключаемся к WebSocket…';
  } else if (pollTimer) {
    el.textContent = '🟡 polling';
    el.className = 'ws-off';
    el.title = 'WebSocket не подключён, polling каждые 3с (fallback)';
  } else {
    el.textContent = '⚫ offline';
    el.className = 'ws-dead';
    el.title = 'Transport не активен';
  }
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(session.token)}`;
}

function connectWS() {
  if (!session?.token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(wsUrl());
  } catch (e) {
    console.warn('WS construction failed', e);
    scheduleReconnect();
    updateWsStatus();
    return;
  }
  updateWsStatus(); // CONNECTING state immediately

  ws.onopen = () => {
    console.log('🔥 WS open');
    wsReconnectAttempt = 0;
    updateWsStatus();
    // Server auto-subscribes us to #general; for any other current room — explicit subscribe.
    if (currentRoom && currentRoom !== 'general') {
      ws.send(JSON.stringify({ type: 'subscribe', room: currentRoom }));
    }
    // На reconnect — re-sync текущей комнаты через tail, чтобы DOM
    // не отстал от БД пока WS лежал. На первом open этого не делаем —
    // login() уже отработал switchRoom и DOM свеж.
    //
    // Дебаунс: если предыдущий open был < 30с назад (WS моргает —
    // flickering reconnect, не реальный длительный disconnect),
    // пропускаем full re-sync — polling-reconciliation подтянет
    // любые пропущенные сообщения через 30с. Без дебаунса каждое
    // моргание = `innerHTML=''` и пересборка DOM, что ломает scroll
    // и даёт «дёргающуюся линейку» (Юджин 11.05 01:38).
    const nowMs = Date.now();
    const sinceLastOpen = nowMs - wsLastOpenAt;
    if (wsHasOpened && sinceLastOpen > WS_RESYNC_DEBOUNCE_MS) {
      console.log(`🔥 WS reconnect after ${Math.round(sinceLastOpen/1000)}s — re-sync tail`);
      const container = document.getElementById('messages');
      if (container) container.innerHTML = '';
      renderToken++;
      roomCursors.delete(currentRoom);
      lastMessageId = 0;
      loadInitialTail(currentRoom);
    } else if (wsHasOpened) {
      console.log(`🔥 WS quick reconnect (${Math.round(sinceLastOpen/1000)}s) — skip DOM flush, polling reconcile`);
    }
    wsLastOpenAt = nowMs;
    wsHasOpened = true;
    // Slow down the polling reconciliation loop now that we have push.
    startPolling();
  };

  ws.onmessage = (ev) => {
    let pkt;
    try { pkt = JSON.parse(ev.data); } catch { return; }
    switch (pkt.type) {
      case 'welcome':
        console.log('🔥 WS welcome', pkt);
        break;
      case 'message':
        handleWsMessage(pkt.message || pkt.data);
        break;
      case 'reactions_updated':
        handleWsReactions(pkt.message_id || pkt.data?.message_id, pkt.reactions || pkt.data?.reactions);
        break;
      case 'presence':
        handleWsPresence(pkt);
        break;
      case 'ping':
        // server keeps us alive; nothing to do
        break;
      default:
        // unknown → ignore but log for visibility
        console.debug('WS msg', pkt.type, pkt);
    }
  };

  ws.onerror = (e) => {
    console.warn('WS error', e);
  };

  ws.onclose = () => {
    console.log('WS closed');
    ws = null;
    scheduleReconnect();
    // While disconnected, fall back to fast polling.
    startPolling();
    updateWsStatus();
  };
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  // Exponential backoff: 1s, 2s, 4s, 8s, ... cap 30s.
  const delay = Math.min(30000, 1000 * Math.pow(2, wsReconnectAttempt));
  wsReconnectAttempt++;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWS();
  }, delay);
}

function handleWsMessage(m) {
  if (!m) return;
  // Push в курсор комнаты независимо от текущей — чтобы при switchRoom туда
  // не тянулись старые сообщения с since=0.
  const cur = roomCursors.get(m.room) || { last: 0, oldest: 0, loaded: false };
  if (m.id > cur.last) {
    cur.last = m.id;
    roomCursors.set(m.room, cur);
  }
  if (m.room !== currentRoom) return;
  // Skip if we already have it (echo of our own POST or reconciliation race).
  if (m.id <= lastMessageId) return;
  const container = document.getElementById('messages');
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  container.appendChild(renderMessage(m));
  lastMessageId = m.id;
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
  // Notification on @mention while hidden.
  if (m.session_id !== session.id && (m.mentions || []).includes(session.name)
      && document.hidden && 'Notification' in window
      && Notification.permission === 'granted') {
    new Notification(`🔥 Очаг — упомянули в #${m.room}`, {
      body: (m.content || '').slice(0, 100),
      icon: '/favicon.ico',
    });
  }
}

function handleWsReactions(messageId, reactions) {
  if (!messageId) return;
  const div = document.getElementById('msg-' + messageId);
  if (!div) return;
  // Replace just the reactions row in place — no full reflow.
  const existing = div.querySelector('.msg-reactions');
  const html = renderReactionsRow({ reactions: reactions || [] });
  if (existing) {
    if (html) {
      existing.outerHTML = html;
    } else {
      existing.remove();
    }
  } else if (html) {
    div.insertAdjacentHTML('beforeend', html);
  }
  // Re-bind click handlers on the new pills.
  const newRow = div.querySelector('.msg-reactions');
  if (newRow) {
    newRow.querySelectorAll('.rxn').forEach(p => {
      p.addEventListener('click', () => sendReaction(messageId, p.dataset.emoji));
    });
  }
}

function handleWsPresence(pkt) {
  // Trigger sessions reload on next tick — cheap and reuses existing renderer.
  tickCounter = -1; // forces sessions update on next tick
}

// ────────────────────────────────────────
// Bootstrap
// ────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // ─── Привязка ВСЕХ обработчиков ОДИН РАЗ, до restore-session check ───
  // Bug-fix 30.04 12:55: раньше handlers привязывались только в else-ветке
  // (после login form). При restore из localStorage — return ДО bind, и
  // Enter в send-form триггерил default submit → reload страницы.

  // login form
  document.getElementById('login-btn').onclick = async () => {
    const name = document.getElementById('login-name').value.trim();
    const role = document.getElementById('login-role').value;
    if (!name) return alert('Имя обязательно');
    try {
      await login(name, role);
    } catch (e) {
      alert('Не удалось войти: ' + e.message);
    }
  };
  document.getElementById('login-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('login-btn').click();
  });

  // form actions
  document.getElementById('send-form').addEventListener('submit', e => {
    e.preventDefault();
    sendMessage();
  });
  document.getElementById('send-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else if (e.key === 'Escape' && replyTo) {
      e.preventDefault();
      clearReplyTarget();
    }
  });
  document.getElementById('send-input').addEventListener('input', e => {
    const t = e.target;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 200) + 'px';
  });
  document.getElementById('logout-btn').onclick = logout;
  document.getElementById('toggle-sidebar').onclick = () => {
    document.getElementById('sidebar').classList.toggle('open');
  };

  // online-only filter (Юджин 30.04 14:53)
  const onlineToggle = document.getElementById('online-only');
  if (onlineToggle) {
    onlineToggle.checked = onlineOnly;
    onlineToggle.addEventListener('change', (e) => {
      onlineOnly = e.target.checked;
      localStorage.setItem('ochag.onlineOnly', String(onlineOnly));
      if (window._sessionsCache) renderSessionList(window._sessionsCache);
    });
  }

  // attach:v2 — image upload (button + paste + drag-drop) через общий helper
  // Bug-fix 30.04 13:05: вытащено из else-ветки login (ниже), иначе при
  // restore session attach/paste/drop НЕ привязаны и Юджин не может
  // прикрепить картинку, paste из буфера тоже мёртв.
  async function uploadImageFile(file, label) {
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) {
      alert('Только картинки');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert('Файл слишком большой (макс 5MB)');
      return;
    }
    const sendInput = document.getElementById('send-input');
    const placeholderText = `[${label || 'загрузка'} ${file.name || ''}…]`;
    const startPos = sendInput.selectionStart;
    const before = sendInput.value.substring(0, startPos);
    const after = sendInput.value.substring(sendInput.selectionEnd);
    sendInput.value = before + placeholderText + after;
    try {
      const fd = new FormData();
      fd.append('file', file, file.name || 'image.png');
      const res = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'X-Session-Token': session.token },
        body: fd,
      });
      if (!res.ok) throw new Error('upload failed: ' + res.status);
      const data = await res.json();
      const markdown = `![${file.name || 'image'}](${data.url})`;
      sendInput.value = sendInput.value.replace(placeholderText, markdown);
    } catch (err) {
      sendInput.value = sendInput.value.replace(placeholderText, '');
      alert('Не удалось загрузить: ' + err.message);
    } finally {
      sendInput.focus();
    }
  }

  const attachBtn = document.getElementById('attach-btn');
  const attachInput = document.getElementById('attach-input');
  if (attachBtn && attachInput) {
    attachBtn.addEventListener('click', () => attachInput.click());
    attachInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      await uploadImageFile(file, 'загрузка');
      attachInput.value = '';
    });
  }

  document.getElementById('send-input').addEventListener('paste', async (e) => {
    const items = (e.clipboardData || {}).items || [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) await uploadImageFile(file, 'вставка');
        return;
      }
    }
  });

  // drag-and-drop image upload
  const chatMain = document.getElementById('chat');
  if (chatMain) {
    let dragCounter = 0;
    const dropOverlay = document.createElement('div');
    dropOverlay.id = 'drop-overlay';
    dropOverlay.textContent = '🖼 Отпусти — загрузим';
    chatMain.appendChild(dropOverlay);

    chatMain.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      dragCounter++;
      dropOverlay.classList.add('active');
    });
    chatMain.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    chatMain.addEventListener('dragleave', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dropOverlay.classList.remove('active');
      }
    });
    chatMain.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      dropOverlay.classList.remove('active');
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      for (const f of files) {
        if (f.type && f.type.startsWith('image/')) {
          await uploadImageFile(f, 'drop');
        }
      }
    });
  }

  // try restore session
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      session = JSON.parse(saved);
      // health-check токена
      const test = await fetch('/api/sessions', {
        headers: { 'Authorization': 'Bearer ' + session.token },
      });
      if (test.ok) {
        showApp();
        await Promise.all([loadRooms(), loadSessions()]);
        await pollMessages();
        startPolling();
        connectWS();
        catchupCheck();
        return;
      }
    } catch (e) { /* fallthrough → login */ }
  }
});

// search:v1 installed
let _searchTimer = null;
let _searchOverlay = null;

function openSearch() {
  if (_searchOverlay) return;
  const overlay = document.createElement('div');
  overlay.id = 'search-overlay';
  overlay.innerHTML = `
    <div class="search-card">
      <input id="search-input" placeholder="Искать в #${currentRoom} …" autofocus>
      <div id="search-results"></div>
      <div class="search-hint">Esc — закрыть · ↑↓ — навигация · Enter — открыть</div>
    </div>
  `;
  document.body.appendChild(overlay);
  _searchOverlay = overlay;

  const input = overlay.querySelector('#search-input');
  input.addEventListener('input', (e) => {
    clearTimeout(_searchTimer);
    const q = e.target.value.trim();
    if (q.length < 2) {
      overlay.querySelector('#search-results').innerHTML = '';
      return;
    }
    _searchTimer = setTimeout(() => doSearch(q), 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSearch();
    if (e.key === 'Enter') {
      const first = overlay.querySelector('.search-hit');
      if (first) first.click();
    }
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSearch();
  });
}

function closeSearch() {
  if (_searchOverlay) {
    _searchOverlay.remove();
    _searchOverlay = null;
  }
  clearTimeout(_searchTimer);
}

async function doSearch(q) {
  if (!_searchOverlay) return;
  try {
    const url = `/api/search?q=${encodeURIComponent(q)}&room=${encodeURIComponent(currentRoom)}&limit=20`;
    const list = await apiGet(url);
    const box = _searchOverlay.querySelector('#search-results');
    if (!list || list.length === 0) {
      box.innerHTML = '<div class="search-empty">Ничего не нашлось</div>';
      return;
    }
    box.innerHTML = list.map(m => {
      const preview = (m.content || '').slice(0, 140).replace(/\n/g, ' ');
      const time = formatTime(m.created_at);
      return `<div class="search-hit" data-id="${m.id}" data-room="${escapeHTML(m.room || currentRoom)}">
        <div class="search-hit-head"><b>${escapeHTML(m.session_name)}</b> <span>#${escapeHTML(m.room || currentRoom)} · ${time}</span></div>
        <div class="search-hit-preview">${escapeHTML(preview)}</div>
      </div>`;
    }).join('');
    box.querySelectorAll('.search-hit').forEach(hit => {
      hit.addEventListener('click', async () => {
        const id = parseInt(hit.dataset.id, 10);
        const room = hit.dataset.room || currentRoom;
        closeSearch();
        if (room !== currentRoom) {
          await switchRoom(room);
        }
        // Scroll to message; flash highlight briefly.
        setTimeout(() => {
          const target = document.getElementById('msg-' + id);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.classList.add('msg-flash');
            setTimeout(() => target.classList.remove('msg-flash'), 1500);
          }
        }, 250);
      });
    });
  } catch (e) {
    console.warn('search failed', e);
  }
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearch();
  }
});

// catchup:v1 installed
async function catchupCheck() {
  try {
    // Use last seen id from storage; if zero — first session, no catchup needed.
    const lastSeen = parseInt(localStorage.getItem('ochag.lastSeenId') || '0', 10);
    if (!lastSeen) return;
    const data = await apiGet(`/api/catchup?since=${lastSeen}&limit=5`);
    if (!data || !data.total_new || data.total_new <= 0) return;
    renderCatchupBanner(data);
  } catch (e) {
    console.warn('catchup check failed', e);
  }
}

function renderCatchupBanner(data) {
  // Remove any existing banner first
  document.getElementById('catchup-banner')?.remove();

  const bar = document.createElement('div');
  bar.id = 'catchup-banner';
  const total = data.total_new || 0;
  const mine = data.my_mentions || 0;
  const minePart = mine > 0 ? ` (${mine} для тебя)` : '';
  bar.innerHTML = `
    <div class="catchup-summary">
      🌅 Пока тебя не было: <b>${total}</b> сообщ.${minePart}
      <button id="catchup-expand">Развернуть</button>
      <button id="catchup-close" title="Скрыть">✕</button>
    </div>
    <div class="catchup-details" hidden></div>
  `;
  const layout = document.querySelector('.layout');
  layout?.parentElement.insertBefore(bar, layout);

  const details = bar.querySelector('.catchup-details');
  bar.querySelector('#catchup-expand').addEventListener('click', () => {
    if (!details.hidden) {
      details.hidden = true;
      bar.querySelector('#catchup-expand').textContent = 'Развернуть';
      return;
    }
    details.hidden = false;
    bar.querySelector('#catchup-expand').textContent = 'Свернуть';
    const items = (data.highlights || []).map(h => {
      const tag = h.is_mention ? '⭐' : (h.from_role === 'human' ? '🧑' : '🌸');
      const preview = (h.preview || h.content || '').slice(0, 200);
      return `<div class="catchup-hit" data-room="${escapeHTML(h.room)}" data-id="${h.msg_id || h.id}">
        ${tag} <b>${escapeHTML(h.from || h.session_name || '?')}</b>
        <span class="catchup-room">#${escapeHTML(h.room)}</span>
        <span class="catchup-preview">${escapeHTML(preview)}</span>
      </div>`;
    }).join('');
    if (items) {
      details.innerHTML = items;
      details.querySelectorAll('.catchup-hit').forEach(hit => {
        hit.addEventListener('click', async () => {
          const room = hit.dataset.room;
          const id = parseInt(hit.dataset.id, 10);
          if (room && room !== currentRoom) await switchRoom(room);
          setTimeout(() => {
            const target = document.getElementById('msg-' + id);
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              target.classList.add('msg-flash');
              setTimeout(() => target.classList.remove('msg-flash'), 1500);
            }
          }, 250);
          bar.remove();
        });
      });
    } else {
      details.innerHTML = '<div class="catchup-empty">Без особых хайлайтов — пройдись по комнатам</div>';
    }
  });
  bar.querySelector('#catchup-close').addEventListener('click', () => {
    bar.remove();
  });
}

// Persist lastMessageId so we can compute the catchup window across refreshes.
const _origPollMessages = pollMessages;
pollMessages = async function() {
  await _origPollMessages.apply(this, arguments);
  if (lastMessageId) localStorage.setItem('ochag.lastSeenId', String(lastMessageId));
};

// Hook catchup check after restore-login or fresh login.
const _origLogin = login;
login = async function(...args) {
  await _origLogin.apply(this, args);
  catchupCheck();
};

// notifications:v1 installed
function maybeAskNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  // Already shown this session?
  if (sessionStorage.getItem('ochag.notif-toast-shown')) return;
  sessionStorage.setItem('ochag.notif-toast-shown', '1');

  const toast = document.createElement('div');
  toast.id = 'notif-toast';
  toast.innerHTML = `
    <span>🔔 Включить уведомления о @mentions?</span>
    <button id="notif-yes">Да</button>
    <button id="notif-no" title="Не сейчас">✕</button>
  `;
  document.body.appendChild(toast);
  toast.querySelector('#notif-yes').addEventListener('click', () => {
    Notification.requestPermission().finally(() => toast.remove());
  });
  toast.querySelector('#notif-no').addEventListener('click', () => toast.remove());
  setTimeout(() => toast.remove(), 12000); // auto-dismiss after 12s
}

// Hook into sendMessage — fire toast on the user's first send.
const _origSendMessage = sendMessage;
sendMessage = async function(...args) {
  await _origSendMessage.apply(this, args);
  maybeAskNotificationPermission();
};

// Очаг — клиентский JS
// 2026-04-28, Лара
// Простой polling раз в 3 сек, без WebSocket пока.

const STORAGE_KEY = 'ochag.session';
const POLL_INTERVAL = 3000;

let session = null;          // {id, name, role, token}
let currentRoom = 'general';
let lastMessageId = 0;
let rooms = [];
let pollTimer = null;

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
  const headers = {};
  if (session?.token) headers['Authorization'] = 'Bearer ' + session.token;
  const r = await fetch(path, { headers });
  if (!r.ok) throw new Error((await r.json()).error || r.statusText);
  return r.json();
}

// ────────────────────────────────────────
// Login
// ────────────────────────────────────────

async function login(name, role) {
  const s = await apiPost('/api/register', { name, role });
  session = s;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  showApp();
  await Promise.all([loadRooms(), loadSessions()]);
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
  lastMessageId = 0;
  document.getElementById('messages').innerHTML = '';
  document.querySelectorAll('#rooms li').forEach(li => {
    li.classList.toggle('active', li.dataset.room === name);
  });
  updateRoomHeader();
  // Tell the server to push us this room's events (welcome auto-subs to #general).
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', room: name }));
  }
  await pollMessages();
}

// ────────────────────────────────────────
// Sessions
// ────────────────────────────────────────

async function loadSessions() {
  const list = await apiGet('/api/sessions') || [];
  const ul = document.getElementById('sessions');
  ul.innerHTML = '';
  list.forEach(s => {
    const li = document.createElement('li');
    const roleEmoji = { sister: '🌸', human: '🧑', coordinator: '🔥' }[s.role] || '·';
    li.textContent = `${roleEmoji} ${s.name}`;
    li.classList.add(s.online ? 'session-online' : 'session-offline');
    ul.appendChild(li);
  });
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
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
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

function renderMessage(m) {
  const div = document.createElement('div');
  div.className = 'msg';
  if (m.session_id === session.id) div.classList.add('own');

  const myMention = (m.mentions || []).includes(session.name);
  if (myMention) div.classList.add('mention');

  // role from session list (если знаем)
  const sessionInList = (window._sessionsCache || []).find(s => s.name === m.session_name);
  const role = sessionInList?.role || 'sister';

  div.innerHTML = `
    <div class="msg-head">
      <span class="msg-author role-${role}">${escapeHTML(m.session_name)}</span>
      <span class="msg-time">${formatTime(m.created_at)}</span>
    </div>
    <div class="msg-content">${formatRich(m.content)}</div>
  `;
  return div;
}

async function pollMessages() {
  try {
    const list = await apiGet(`/api/messages?since=${lastMessageId}&room=${currentRoom}&limit=200`);
    if (!list || list.length === 0) return;
    const container = document.getElementById('messages');
    const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    list.forEach(m => {
      container.appendChild(renderMessage(m));
      if (m.id > lastMessageId) lastMessageId = m.id;
    });
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

async function sendMessage() {
  const input = document.getElementById('send-input');
  const text = input.value.trim();
  if (!text) return;
  try {
    await apiPost('/api/messages', { room: currentRoom, content: text });
    input.value = '';
    input.style.height = 'auto';
    await pollMessages();
  } catch (e) {
    alert('Не отправлено: ' + e.message);
  }
}

// ────────────────────────────────────────
// Polling loop
// ────────────────────────────────────────

async function tick() {
  await pollMessages();
  // обновляем sessions список реже — каждые 3 тика = 9 сек
  if (++tickCounter % 3 === 0) {
    const list = await apiGet('/api/sessions');
    window._sessionsCache = list;
    const ul = document.getElementById('sessions');
    ul.innerHTML = '';
    list.forEach(s => {
      const li = document.createElement('li');
      const roleEmoji = { sister: '🌸', human: '🧑', coordinator: '🔥' }[s.role] || '·';
      li.textContent = `${roleEmoji} ${s.name}`;
      li.classList.add(s.online ? 'session-online' : 'session-offline');
      ul.appendChild(li);
    });
  }
}

let tickCounter = 0;
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  // While WS is alive we still poll, just rarely (reconciliation only).
  const interval = ws && ws.readyState === WebSocket.OPEN ? 30000 : POLL_INTERVAL;
  pollTimer = setInterval(tick, interval);
}

// ────────────────────────────────────────
// WebSocket — real-time transport
// ────────────────────────────────────────

let ws = null;
let wsReconnectAttempt = 0;
let wsReconnectTimer = null;

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
    return;
  }

  ws.onopen = () => {
    console.log('🔥 WS open');
    wsReconnectAttempt = 0;
    // Server auto-subscribes us to #general; for any other current room — explicit subscribe.
    if (currentRoom && currentRoom !== 'general') {
      ws.send(JSON.stringify({ type: 'subscribe', room: currentRoom }));
    }
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
  if (!m || m.room !== currentRoom) return;
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
  // Find the rendered message and update its reactions row (TODO when reactions UI is in).
  // For now just trigger a poll so flat list refreshes.
  pollMessages();
}

function handleWsPresence(pkt) {
  // Trigger sessions reload on next tick — cheap and reuses existing renderer.
  tickCounter = -1; // forces sessions update on next tick
}

// ────────────────────────────────────────
// Bootstrap
// ────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
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
        return;
      }
    } catch (e) { /* fallthrough → login */ }
  }

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
});

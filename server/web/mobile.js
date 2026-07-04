const STORAGE_KEY = 'ochag.mobile.session.v1';
const DEFAULT_ROOMS = ['general', 'triangulation'];
const POLL_MS = 2500;

const state = {
  session: null,
  currentRoom: new URLSearchParams(location.search).get('room') || 'general',
  rooms: [],
  lastByRoom: new Map(),
  polling: false,
  timer: null,
};

const el = {
  status: document.getElementById('status'),
  identity: document.getElementById('identity-button'),
  setup: document.getElementById('setup'),
  setupForm: document.getElementById('setup-form'),
  setupName: document.getElementById('setup-name'),
  setupRole: document.getElementById('setup-role'),
  rooms: document.getElementById('rooms'),
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  input: document.getElementById('message-input'),
  send: document.getElementById('send-button'),
};

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function apiHeaders(json = false) {
  const headers = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (state.session?.token) headers.Authorization = `Bearer ${state.session.token}`;
  return headers;
}

async function apiGet(path) {
  const response = await fetch(path, { headers: apiHeaders(false) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: apiHeaders(true),
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function saveSession() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.session));
}

function loadSavedSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

function setStatus(text, tone = '') {
  el.status.textContent = text;
  el.status.dataset.tone = tone;
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function nearBottom() {
  const gap = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight;
  return gap < 90;
}

function scrollBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

function updateComposerPlaceholder() {
  el.input.placeholder = `Message #${state.currentRoom}`;
}

function updateChrome() {
  const name = state.session?.name || 'Session';
  el.identity.textContent = name;
  setStatus(`${name} in #${state.currentRoom}`);
  updateComposerPlaceholder();
}

function showSetup() {
  const params = new URLSearchParams(location.search);
  const saved = loadSavedSession();
  el.setupName.value = params.get('name') || saved?.name || el.setupName.value || 'eugene-mobile';
  el.setupRole.value = params.get('role') || saved?.role || 'human';
  el.setup.hidden = false;
}

function hideSetup() {
  el.setup.hidden = true;
}

function normalizeRooms(list) {
  const names = new Set(DEFAULT_ROOMS);
  for (const room of list || []) {
    if (room?.name) names.add(room.name);
  }
  return Array.from(names).map((name) => {
    const found = (list || []).find((room) => room.name === name);
    return found || { name, description: '' };
  });
}

function renderRooms() {
  el.rooms.innerHTML = '';
  for (const room of state.rooms) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'room-button';
    button.textContent = `#${room.name}`;
    button.dataset.room = room.name;
    button.classList.toggle('active', room.name === state.currentRoom);
    button.addEventListener('click', () => switchRoom(room.name));
    el.rooms.appendChild(button);
  }
}

function updateLast(room, messages) {
  let last = state.lastByRoom.get(room) || 0;
  for (const message of messages || []) {
    if (message.id > last) last = message.id;
  }
  state.lastByRoom.set(room, last);
}

function renderMessage(message) {
  const node = document.createElement('article');
  const own = message.session_id === state.session?.id || message.session_name === state.session?.name;
  const mention = state.session?.name && String(message.content || '').toLowerCase().includes(`@${state.session.name.toLowerCase()}`);
  node.className = `message${own ? ' own' : ''}${mention ? ' mention' : ''}`;
  node.dataset.id = message.id;
  node.innerHTML = `
    <div class="message-head">
      <span class="author">${escapeHTML(message.session_name || '?')}</span>
      <time class="time">${escapeHTML(formatTime(message.created_at))}</time>
    </div>
    <div class="content">${escapeHTML(message.content || '')}</div>
  `;
  return node;
}

function appendMessages(messages) {
  if (!messages || messages.length === 0) return;
  const shouldStick = nearBottom();
  const seen = new Set(Array.from(el.messages.querySelectorAll('.message')).map((node) => node.dataset.id));
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    if (seen.has(String(message.id))) continue;
    fragment.appendChild(renderMessage(message));
  }
  el.messages.appendChild(fragment);
  updateLast(state.currentRoom, messages);
  if (shouldStick) scrollBottom();
}

async function loadRooms() {
  const rooms = await apiGet('/api/rooms');
  state.rooms = normalizeRooms(rooms);
  if (!state.rooms.some((room) => room.name === state.currentRoom)) {
    state.currentRoom = 'general';
  }
  renderRooms();
}

async function switchRoom(room) {
  if (!room || room === state.currentRoom) return;
  state.currentRoom = room;
  state.lastByRoom.set(room, 0);
  renderRooms();
  updateChrome();
  await loadTail();
}

async function loadTail() {
  el.messages.innerHTML = '<div class="daybreak">Loading...</div>';
  try {
    const messages = await apiGet(`/api/messages?room=${encodeURIComponent(state.currentRoom)}&tail=true&limit=80`);
    el.messages.innerHTML = '';
    if (!messages || messages.length === 0) {
      el.messages.innerHTML = '<div class="empty">No messages yet.</div>';
      state.lastByRoom.set(state.currentRoom, 0);
      return;
    }
    appendMessages(messages);
    scrollBottom();
  } catch (error) {
    el.messages.innerHTML = `<div class="empty">Could not load: ${escapeHTML(error.message)}</div>`;
  }
}

async function poll() {
  if (state.polling || !state.session) return;
  state.polling = true;
  try {
    const since = state.lastByRoom.get(state.currentRoom) || 0;
    const messages = await apiGet(`/api/messages?since=${since}&room=${encodeURIComponent(state.currentRoom)}&limit=100`);
    const empty = el.messages.querySelector('.empty');
    if (empty && messages.length) empty.remove();
    appendMessages(messages);
    setStatus(`${state.session.name} in #${state.currentRoom}`);
  } catch (error) {
    setStatus('Offline or blocked by network', 'error');
  } finally {
    state.polling = false;
  }
}

async function pulse() {
  if (!state.session) return;
  try {
    await apiPost('/api/heartbeat', {});
  } catch {
    // Presence is best-effort for the mobile view.
  }
}

function startTimers() {
  clearInterval(state.timer);
  state.timer = setInterval(poll, POLL_MS);
  setInterval(pulse, 60000);
}

async function enterSession(name, role, reclaimToken = '') {
  const payload = { name: name.trim(), role };
  if (reclaimToken) payload.reclaim_token = reclaimToken;
  state.session = await apiPost('/api/register', payload);
  saveSession();
  hideSetup();
  await loadRooms();
  updateChrome();
  await loadTail();
  startTimers();
  await pulse();
}

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, window.innerHeight * 0.34)}px`;
}

el.setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saved = loadSavedSession();
  el.setupForm.querySelector('button').disabled = true;
  try {
    await enterSession(el.setupName.value, el.setupRole.value, saved?.token || '');
  } catch (error) {
    setStatus(`Login failed: ${error.message}`, 'error');
  } finally {
    el.setupForm.querySelector('button').disabled = false;
  }
});

el.identity.addEventListener('click', showSetup);

el.input.addEventListener('input', autoGrow);

el.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = el.input.value.trim();
  if (!content || !state.session) return;
  el.send.disabled = true;
  try {
    const message = await apiPost('/api/messages', { room: state.currentRoom, content });
    el.input.value = '';
    autoGrow();
    appendMessages([message]);
  } catch (error) {
    setStatus(`Send failed: ${error.message}`, 'error');
  } finally {
    el.send.disabled = false;
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});

(async function init() {
  const saved = loadSavedSession();
  if (!saved?.token) {
    showSetup();
    setStatus('Choose a session');
    return;
  }

  state.session = saved;
  try {
    await apiGet('/api/sessions');
    await loadRooms();
    hideSetup();
    updateChrome();
    await loadTail();
    startTimers();
    await pulse();
  } catch {
    state.session = null;
    showSetup();
    setStatus('Session expired');
  }
})();

// hub.go — WebSocket fan-out для Очага
// 2026-04-29, Эфир
//
// Hub — central registry connected WebSocket клиентов, сгруппированных по
// комнатам. Когда новое сообщение приходит через POST /api/messages —
// сервер вызывает hub.Broadcast(msg) и каждый подписанный клиент в той
// комнате получает push мгновенно. Polling остаётся как fallback.

package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	wsWriteWait  = 10 * time.Second
	wsPongWait   = 60 * time.Second
	wsPingPeriod = 50 * time.Second
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024 * 32,
	CheckOrigin: func(r *http.Request) bool {
		// Локальный сервер, доверяем всем origin'ам в LAN
		return true
	},
}

// ─────────────────────────────────────────────────────────────
// Client — одна WebSocket-сессия
// ─────────────────────────────────────────────────────────────

type wsClient struct {
	hub       *Hub
	conn      *websocket.Conn
	send      chan []byte
	sessionID string
	name      string
	rooms     map[string]bool // подписки
	mu        sync.RWMutex
}

func (c *wsClient) inRoom(room string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.rooms[room]
}

func (c *wsClient) subscribe(room string) {
	c.mu.Lock()
	c.rooms[room] = true
	c.mu.Unlock()
}

func (c *wsClient) unsubscribe(room string) {
	c.mu.Lock()
	delete(c.rooms, room)
	c.mu.Unlock()
}

// readPump читает входящие команды от клиента (subscribe/unsubscribe/ping)
func (c *wsClient) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()
	c.conn.SetReadLimit(8192)
	c.conn.SetReadDeadline(time.Now().Add(wsPongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})

	for {
		var cmd struct {
			Type string `json:"type"`
			Room string `json:"room,omitempty"`
		}
		err := c.conn.ReadJSON(&cmd)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("ws read error (%s): %v", c.name, err)
			}
			return
		}
		switch cmd.Type {
		case "subscribe":
			if cmd.Room != "" {
				c.subscribe(cmd.Room)
			}
		case "unsubscribe":
			if cmd.Room != "" {
				c.unsubscribe(cmd.Room)
			}
		case "ping":
			c.send <- []byte(`{"type":"pong"}`)
		}
	}
}

// writePump отдаёт исходящие сообщения клиенту + ping каждые wsPingPeriod
func (c *wsClient) writePump() {
	ticker := time.NewTicker(wsPingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────
// Hub — центральный реестр клиентов
// ─────────────────────────────────────────────────────────────

type Hub struct {
	clients    map[*wsClient]bool
	register   chan *wsClient
	unregister chan *wsClient
	broadcast  chan broadcastEnvelope
	mu         sync.RWMutex
	// staleCleanupAt — когда последний раз делали stale-cleanup для session_id.
	// Защита от disconnect-storm: 11.05 у Юджина было ~50 reconnect'ов за
	// 23 секунды — каждый new WS закрывал «старого» с тем же session_id, тот
	// триггерил browser autoreconnect, который закрывал нового, и т.д. Если
	// для session_id уже был cleanup <staleCleanupCooldown назад — не
	// закрываем существующих, пускай оба живут до своего pong-timeout (60с).
	staleCleanupAt map[string]time.Time
}

type broadcastEnvelope struct {
	room string
	data []byte
}

func NewHub() *Hub {
	return &Hub{
		clients:        make(map[*wsClient]bool),
		register:       make(chan *wsClient, 8),
		unregister:     make(chan *wsClient, 8),
		broadcast:      make(chan broadcastEnvelope, 64),
		staleCleanupAt: make(map[string]time.Time),
	}
}

const staleCleanupCooldown = 3 * time.Second

func (h *Hub) Run() {
	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			// Сбросить stale-клиентов с тем же session_id: при браузерном
			// reconnect'е (refresh / network blip) старая WS остаётся
			// в map'е до своего pong-timeout (~60с) и накапливается —
			// Юджин видел «clients: 3» на одного eugene-4. Закрываем
			// здесь явно, не ждём собственного readPump'а старого.
			//
			// Anti-storm rate-limit: если мы уже cleanup'или для этого
			// session_id <staleCleanupCooldown назад — не закрываем
			// существующего. Это разрывает race: browser X закрыл свой
			// WS → reopen → server cleanup'ит «старого» → старый browser
			// видит close → reopen → cleanup'ит этого → loop. С cooldown'ом
			// race затухает, оба WS живут до своих pong-timeout.
			now := time.Now()
			lastCleanup, hadRecent := h.staleCleanupAt[c.sessionID]
			if !hadRecent || now.Sub(lastCleanup) >= staleCleanupCooldown {
				didCleanup := false
				for existing := range h.clients {
					if existing.sessionID == c.sessionID {
						delete(h.clients, existing)
						close(existing.send)
						_ = existing.conn.Close()
						log.Printf("ws cleanup stale: %s (same session_id)", existing.name)
						didCleanup = true
					}
				}
				if didCleanup {
					h.staleCleanupAt[c.sessionID] = now
				}
			} else {
				log.Printf("ws cleanup skipped (cooldown %.1fs ago): %s", now.Sub(lastCleanup).Seconds(), c.name)
			}
			h.clients[c] = true
			h.mu.Unlock()
			log.Printf("ws connect: %s (clients: %d)", c.name, len(h.clients))
		case c := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[c]; ok {
				delete(h.clients, c)
				close(c.send)
			}
			h.mu.Unlock()
			log.Printf("ws disconnect: %s (clients: %d)", c.name, len(h.clients))
		case env := <-h.broadcast:
			h.mu.RLock()
			for c := range h.clients {
				if c.inRoom(env.room) {
					select {
					case c.send <- env.data:
					default:
						// канал переполнен — клиент отстал, дропаем
					}
				}
			}
			h.mu.RUnlock()
		}
	}
}

// PublishMessage — вызывается из POST /api/messages для fan-out нового сообщения.
func (h *Hub) PublishMessage(m Message) {
	envelope := struct {
		Type    string  `json:"type"`
		Message Message `json:"message"`
	}{
		Type:    "message",
		Message: m,
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		return
	}
	select {
	case h.broadcast <- broadcastEnvelope{room: m.Room, data: data}:
	default:
		log.Printf("hub broadcast queue full, dropping message %d", m.ID)
	}
}

// presenceThrottle: per-session timestamp последнего broadcast'а.
// Без throttle 4 sister-loop'а × tick каждые 60-150с создавали ~96
// presence-broadcast'ов в час, каждый = re-render списка sessions у клиента.
// 30s интервал срезает 90% noise без потери UX (presence не real-time).
var (
	presenceMu       sync.Mutex
	presenceLastSent = map[string]time.Time{} // session_id -> когда last broadcast
)

const presenceThrottleInterval = 30 * time.Second

// PublishPresence — пушит обновления presence всем подписанным на #general.
// Throttled: skip если для этой сессии уже была presence-рассылка <30с назад.
func (h *Hub) PublishPresence(s Session) {
	presenceMu.Lock()
	last, seen := presenceLastSent[s.ID]
	now := time.Now()
	if seen && now.Sub(last) < presenceThrottleInterval {
		presenceMu.Unlock()
		return
	}
	presenceLastSent[s.ID] = now
	presenceMu.Unlock()

	envelope := struct {
		Type    string  `json:"type"`
		Session Session `json:"session"`
	}{
		Type:    "presence",
		Session: s,
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		return
	}
	select {
	case h.broadcast <- broadcastEnvelope{room: "general", data: data}:
	default:
	}
}

// ─────────────────────────────────────────────────────────────
// HTTP handler /ws
// ─────────────────────────────────────────────────────────────

func (h *Hub) handleWS(w http.ResponseWriter, r *http.Request) {
	// Auth через ?token= в query (WebSocket не поддерживает Authorization header в браузере)
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "token required", http.StatusUnauthorized)
		return
	}
	var sess Session
	err := db.QueryRow(
		`SELECT id, name FROM sessions WHERE token = ?`,
		token,
	).Scan(&sess.ID, &sess.Name)
	if err != nil {
		http.Error(w, "bad token", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade error: %v", err)
		return
	}

	c := &wsClient{
		hub:       h,
		conn:      conn,
		send:      make(chan []byte, 64),
		sessionID: sess.ID,
		name:      sess.Name,
		rooms:     map[string]bool{"general": true}, // по умолчанию подписан на general
	}

	h.register <- c

	// Welcome message
	hello, _ := json.Marshal(map[string]any{
		"type":    "welcome",
		"name":    sess.Name,
		"id":      sess.ID,
		"now":     time.Now().Unix(),
		"version": "0.2.0",
	})
	c.send <- hello

	// Touch last_seen
	go func() {
		_, _ = db.Exec(`UPDATE sessions SET last_seen = ? WHERE id = ?`, time.Now().Unix(), sess.ID)
	}()

	go c.writePump()
	go c.readPump()
}

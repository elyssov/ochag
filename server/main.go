// Очаг — локальный мессенджер Гидры
// 2026-04-28, Лара
// Из искры — пламя 🔥
//
// Запуск:    go run . (или собранный ochag.exe)
// Адрес:     http://127.0.0.1:7766/  и http://<lan-ip>:7766/  для мобилки
// Хранилище: ochag.db (SQLite, рядом с бинарём)
// Авторизация: bearer token, выдаётся при /api/register

package main

import (
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

//go:embed web/chat.html
var chatHTML []byte

//go:embed web/chat.js
var chatJS []byte

//go:embed web/chat.css
var chatCSS []byte

//go:embed web/mobile.html
var mobileHTML []byte

//go:embed web/mobile.js
var mobileJS []byte

//go:embed web/mobile.css
var mobileCSS []byte

const (
	defaultPort = 7766
	dbFile      = "ochag.db"
)

var db *sql.DB
var hub *Hub

// ─────────────────────────────────────────────────────────────
// Модели
// ─────────────────────────────────────────────────────────────

type Session struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Role       string `json:"role"` // sister | human | coordinator
	Token      string `json:"token,omitempty"`
	CreatedAt  int64  `json:"created_at"`
	LastSeen   int64  `json:"last_seen"`
	NextTickAt int64  `json:"next_tick_at,omitempty"`
	Online     bool   `json:"online"`           // last_seen в пределах 90 сек (legacy)
	State      string `json:"state,omitempty"`  // active | idle | mid-task | sleeping | offline
	StateLabel string `json:"state_label,omitempty"` // для UI: "active", "sleeping until 14:32"
}

// computePresence вычисляет 5-уровневое состояние сессии на основе
// last_seen и next_tick_at. Используется в /api/sessions и в WS push.
func computePresence(s *Session) {
	n := now()
	sinceLast := n - s.LastSeen
	hasFutureCron := s.NextTickAt > n
	cronIn := s.NextTickAt - n

	switch {
	case sinceLast < 30 && hasFutureCron:
		s.State = "mid-task"
		s.StateLabel = "active"
	case sinceLast < 30:
		s.State = "active"
		s.StateLabel = "active"
	case hasFutureCron && cronIn < 600:
		s.State = "sleeping"
		// "sleeping until 14:32" локально форматировать нельзя — отдаём cron_in_secs
		mins := cronIn / 60
		if mins < 1 {
			s.StateLabel = "tick in <1m"
		} else {
			s.StateLabel = fmt.Sprintf("tick in %dm", mins)
		}
	case sinceLast < 300:
		s.State = "idle"
		s.StateLabel = "idle"
	case sinceLast < 900:
		s.State = "away"
		s.StateLabel = "away"
	default:
		s.State = "offline"
		s.StateLabel = "offline"
	}
	s.Online = sinceLast < 90 // legacy compat
}

type Message struct {
	ID          int64           `json:"id"`
	Room        string          `json:"room"`
	SessionID   string          `json:"session_id"`
	SessionName string          `json:"session_name"`
	Content     string          `json:"content"`
	Mentions    []string        `json:"mentions,omitempty"`
	ReplyTo     *int64          `json:"reply_to,omitempty"`
	CreatedAt   int64           `json:"created_at"`
	Reactions   []ReactionGroup `json:"reactions,omitempty"`
	Replies     []Message       `json:"replies,omitempty"` // только при ?threaded=true
}

type ReactionGroup struct {
	Emoji   string   `json:"emoji"`
	Count   int      `json:"count"`
	Authors []string `json:"authors"` // session_name'ы
}

type Room struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	CreatedAt   int64  `json:"created_at"`
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

func now() int64 { return time.Now().Unix() }

// normalizeName приводит handle к единой форме: lower + trim + ё→е.
// Это позволяет «алёна» и «алена» с разных устройств попадать в одну сессию.
func normalizeName(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, "ё", "е")
	return s
}

func hasColumn(table, col string) bool {
	rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err == nil {
			if name == col {
				return true
			}
		}
	}
	return false
}

// stripCodeRegions удаляет fenced code blocks (```...```) и inline-код (`...`)
// перед парсингом mentions — чтобы примеры кода с @-цитатами не ловились
// как mentions. Это решает мой собственный повторяющийся баг где
// «@botfather» внутри инструкции превращался в mention.
func stripCodeRegions(text string) string {
	// fenced code blocks first (```...```)
	out := []byte{}
	i := 0
	for i < len(text) {
		if i+2 < len(text) && text[i] == '`' && text[i+1] == '`' && text[i+2] == '`' {
			// найти закрывающий ```
			end := strings.Index(text[i+3:], "```")
			if end < 0 {
				// незакрытый — пропускаем до конца
				return string(out)
			}
			i = i + 3 + end + 3
			continue
		}
		if text[i] == '`' {
			// inline code до следующего `
			end := strings.Index(text[i+1:], "`")
			if end < 0 {
				out = append(out, text[i])
				i++
				continue
			}
			i = i + 1 + end + 1
			continue
		}
		out = append(out, text[i])
		i++
	}
	return string(out)
}

func parseMentions(text string) []string {
	clean := stripCodeRegions(text)
	var out []string
	seen := map[string]bool{}
	for _, w := range strings.Fields(clean) {
		if !strings.HasPrefix(w, "@") || len(w) < 2 {
			continue
		}
		name := strings.TrimRight(w[1:], ",.!?:;)\"'»")
		name = strings.ToLower(name)
		if name == "" {
			continue
		}
		// дополнительный фильтр: не считать mention если начинается с цифры
		// (например @100mhz, @99problems) или содержит = / : (типа @mention=+100)
		if name[0] >= '0' && name[0] <= '9' {
			continue
		}
		if strings.ContainsAny(name, "=:/") {
			continue
		}
		if !seen[name] {
			out = append(out, name)
			seen[name] = true
		}
	}
	return out
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// authTouchPending — last_seen touches буферизированные между flush'ами.
// authSession() вызывается на каждом authenticated request (poll, send,
// react, upload, /ws auth). Прямой db.Exec UPDATE на каждом — это десятки
// writes/сек при активной семье + tick'ах sister-loops, и под WAL они
// всё равно сериализуются, забивая writer queue. Cache + 10s flush
// батчит их в одну транзакцию: один writer-grab за 10с вместо сотен.
// last_seen нужен только для presence list (UI обновляет каждые 30с),
// 10-секундная задержка в БД незаметна.
var (
	authTouchMu      sync.Mutex
	authTouchPending = map[string]int64{} // session_id -> last_seen ts
)

func recordAuthTouch(sessionID string) {
	authTouchMu.Lock()
	authTouchPending[sessionID] = now()
	authTouchMu.Unlock()
}

func flushAuthTouches() {
	authTouchMu.Lock()
	if len(authTouchPending) == 0 {
		authTouchMu.Unlock()
		return
	}
	pending := authTouchPending
	authTouchPending = map[string]int64{}
	authTouchMu.Unlock()

	tx, err := db.Begin()
	if err != nil {
		log.Printf("flushAuthTouches begin: %v", err)
		return
	}
	stmt, err := tx.Prepare(`UPDATE sessions SET last_seen = ? WHERE id = ?`)
	if err != nil {
		_ = tx.Rollback()
		log.Printf("flushAuthTouches prepare: %v", err)
		return
	}
	for id, ts := range pending {
		if _, err := stmt.Exec(ts, id); err != nil {
			log.Printf("flushAuthTouches exec(%s): %v", id, err)
		}
	}
	_ = stmt.Close()
	if err := tx.Commit(); err != nil {
		log.Printf("flushAuthTouches commit: %v", err)
	}
}

func startAuthFlushLoop(interval time.Duration) {
	ticker := time.NewTicker(interval)
	for range ticker.C {
		flushAuthTouches()
	}
}

func authSession(r *http.Request) (*Session, error) {
	auth := r.Header.Get("Authorization")
	token := strings.TrimPrefix(auth, "Bearer ")
	if token == "" {
		// fallback: X-Session-Token (используется в некоторых частях chat.js — POST react, upload)
		token = r.Header.Get("X-Session-Token")
	}
	if token == "" {
		// fallback: ?token= (для web UI чтобы не возиться с заголовками)
		token = r.URL.Query().Get("token")
	}
	if token == "" {
		return nil, fmt.Errorf("no token")
	}
	var s Session
	err := db.QueryRow(
		`SELECT id, name, role, created_at, last_seen FROM sessions WHERE token = ?`,
		token,
	).Scan(&s.ID, &s.Name, &s.Role, &s.CreatedAt, &s.LastSeen)
	if err != nil {
		return nil, err
	}
	// touch last_seen — буферизируется, flush раз в 10с (см. flushAuthTouches)
	recordAuthTouch(s.ID)
	return &s, nil
}

// ─────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────

// POST /api/register   {name, role, reclaim_token?}  → {id, name, role, token}
//
// КАЖДАЯ регистрация = новая сессия с уникальным id и токеном.
// Если name занят — авто-суффикс (name-2, name-3, ...). Клиент получает
// в ответе фактическое имя. Это гарантирует identity isolation между сессиями.
//
// Опциональное reclaim_token: если в теле есть токен существующей сессии
// с тем же name — обновляем эту сессию (новый токен), не плодим суффиксы.
// Так сессия может «переподключиться» под своим именем после перезапуска.
func handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, 405, "POST only")
		return
	}
	var body struct {
		Name         string `json:"name"`
		Role         string `json:"role"`
		ReclaimToken string `json:"reclaim_token,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "bad json")
		return
	}
	body.Name = normalizeName(body.Name)
	if body.Name == "" {
		writeErr(w, 400, "name required")
		return
	}
	if body.Role == "" {
		body.Role = "sister"
	}

	var s Session
	s.Role = body.Role
	s.CreatedAt = now()
	s.LastSeen = now()
	s.Token = uuid.NewString()

	// Reclaim path: тот же owner возвращает себе имя через valid token.
	// Identity-drift fix (11.05.2026): клиент мог сохранить token от сессии
	// с суффиксом (получил main-2 при предыдущем register'е, записал его
	// token в .ochag-token-main), потом приходит с args.name='main' +
	// reclaim_token=T_main-2. Строгий match WHERE name='main' AND token=T
	// не найдёт (T принадлежит main-2). Fallback: WHERE token=T — token
	// уникален де-факто (uuid.NewString, шанс коллизии ~1/2^122) и =
	// полный bearer credential, identity hijack невозможен (если кто-то
	// уже знает T, у него уже есть auth этой сессии). Возвращаем actual
	// stored name; client должен использовать его дальше.
	if body.ReclaimToken != "" {
		var existingID, existingName string
		err := db.QueryRow(
			`SELECT id, name FROM sessions WHERE LOWER(REPLACE(name, 'ё', 'е')) = ? AND token = ?`,
			body.Name, body.ReclaimToken,
		).Scan(&existingID, &existingName)
		matchKind := "strict"
		if err != nil {
			err = db.QueryRow(
				`SELECT id, name FROM sessions WHERE token = ?`,
				body.ReclaimToken,
			).Scan(&existingID, &existingName)
			matchKind = "token-only"
		}
		if err == nil {
			s.ID = existingID
			s.Name = existingName
			_, err = db.Exec(
				`UPDATE sessions SET role = ?, token = ?, last_seen = ? WHERE id = ?`,
				s.Role, s.Token, s.LastSeen, s.ID,
			)
			if err != nil {
				writeErr(w, 500, err.Error())
				return
			}
			log.Printf("reclaim OK (%s): requested=%q resolved=%q id=%s old_token=%s… new_token=%s…",
				matchKind, body.Name, existingName, existingID[:8],
				body.ReclaimToken[:min(8, len(body.ReclaimToken))], s.Token[:8])
			writeJSON(w, 200, s)
			return
		}
		// reclaim не сработал ни строго, ни по token-only → fallthrough.
		log.Printf("reclaim FAIL: requested=%q reclaim_token=%s… err=%v",
			body.Name, body.ReclaimToken[:min(8, len(body.ReclaimToken))], err)
	}

	// Defence in depth: если клиент шлёт Authorization: Bearer <token>
	// (как в обычных POST), и этот token принадлежит сессии с тем же
	// именем — reuse её. Это защищает от eugene-N suffix накопления
	// при refresh браузера у пользователя который не использует
	// reclaim_token flow явно (старый client.js, manual API call).
	if existing, err := authSession(r); err == nil && normalizeName(existing.Name) == body.Name {
		s.ID = existing.ID
		s.Name = existing.Name
		s.Token = existing.Token // оставляем старый валидный, не ротируем
		_, err = db.Exec(
			`UPDATE sessions SET role = ?, last_seen = ? WHERE id = ?`,
			s.Role, s.LastSeen, s.ID,
		)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, s)
		return
	}

	// Имя занято? Подбираем уникальный суффикс.
	// Сравнение нормализованное — «алёна»/«алена» считаются одним именем.
	finalName := body.Name
	for i := 2; i < 1000; i++ {
		var taken int
		_ = db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE LOWER(REPLACE(name, 'ё', 'е')) = ?`, finalName).Scan(&taken)
		if taken == 0 {
			break
		}
		finalName = fmt.Sprintf("%s-%d", body.Name, i)
	}
	s.Name = finalName
	s.ID = uuid.NewString()
	if _, err := db.Exec(
		`INSERT INTO sessions (id, name, role, token, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)`,
		s.ID, s.Name, s.Role, s.Token, s.CreatedAt, s.LastSeen,
	); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, s)
}

// GET /api/sessions  — список сессий с computed presence-state
func handleSessions(w http.ResponseWriter, r *http.Request) {
	if _, err := authSession(r); err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}
	rows, err := db.Query(`SELECT id, name, role, created_at, last_seen, COALESCE(next_tick_at,0) FROM sessions ORDER BY name`)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	var list []Session
	for rows.Next() {
		var s Session
		_ = rows.Scan(&s.ID, &s.Name, &s.Role, &s.CreatedAt, &s.LastSeen, &s.NextTickAt)
		computePresence(&s)
		list = append(list, s)
	}
	writeJSON(w, 200, list)
}

// POST /api/heartbeat  {next_tick_at?: int}
//
// Клиент дёргает регулярно (например, перед каждым cron-tick'ом). Сервер
// обновляет last_seen и опционально next_tick_at, чтобы presence-state был
// точным. Особенно важно для cron'ов: «я проснусь через 47 секунд» даёт
// presence «🟣 sleeping until 14:32» вместо неопределённого «idle».
func handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, 405, "POST only")
		return
	}
	s, err := authSession(r)
	if err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}
	var body struct {
		NextTickAt int64 `json:"next_tick_at,omitempty"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body) // OK если body пустое

	if body.NextTickAt > 0 {
		_, _ = db.Exec(`UPDATE sessions SET next_tick_at = ?, last_seen = ? WHERE id = ?`,
			body.NextTickAt, now(), s.ID)
	} else {
		_, _ = db.Exec(`UPDATE sessions SET last_seen = ? WHERE id = ?`, now(), s.ID)
	}

	// Возвращаем computed state (для self-check)
	updated := *s
	updated.LastSeen = now()
	updated.NextTickAt = body.NextTickAt
	computePresence(&updated)

	// WS-push presence-update подписанным на #general
	if hub != nil {
		hub.PublishPresence(updated)
	}

	writeJSON(w, 200, updated)
}

// GET /api/rooms — список комнат
func handleRooms(w http.ResponseWriter, r *http.Request) {
	if _, err := authSession(r); err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}
	rows, err := db.Query(`SELECT name, description, created_at FROM rooms ORDER BY name`)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	var list []Room
	for rows.Next() {
		var room Room
		_ = rows.Scan(&room.Name, &room.Description, &room.CreatedAt)
		list = append(list, room)
	}
	writeJSON(w, 200, list)
}

// POST /api/messages   {room, content, reply_to?} → {message}
func handlePostMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, 405, "POST only")
		return
	}
	s, err := authSession(r)
	if err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}
	var body struct {
		Room    string `json:"room"`
		Content string `json:"content"`
		ReplyTo *int64 `json:"reply_to,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "bad json")
		return
	}
	body.Room = strings.TrimSpace(body.Room)
	body.Content = strings.TrimSpace(body.Content)
	if body.Room == "" {
		body.Room = "general"
	}
	if body.Content == "" {
		writeErr(w, 400, "content required")
		return
	}
	mentions := parseMentions(body.Content)
	mentionsJSON, _ := json.Marshal(mentions)

	res, err := db.Exec(
		`INSERT INTO messages (room, session_id, session_name, content, mentions, reply_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
		body.Room, s.ID, s.Name, body.Content, string(mentionsJSON), body.ReplyTo, now(),
	)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	id, _ := res.LastInsertId()
	msg := Message{
		ID:          id,
		Room:        body.Room,
		SessionID:   s.ID,
		SessionName: s.Name,
		Content:     body.Content,
		Mentions:    mentions,
		ReplyTo:     body.ReplyTo,
		CreatedAt:   now(),
	}
	// Push в WebSocket-подписчиков комнаты для real-time доставки.
	if hub != nil {
		hub.PublishMessage(msg)
	}
	writeJSON(w, 200, msg)
}

// GET /api/messages?since=ID&room=NAME&limit=N&threaded=true
func handleGetMessages(w http.ResponseWriter, r *http.Request) {
	if _, err := authSession(r); err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	room := r.URL.Query().Get("room")
	threaded := r.URL.Query().Get("threaded") == "true"
	tail := r.URL.Query().Get("tail") == "true"
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	// before=X → старые сообщения (id < X) для lazy scroll-up.
	// При before>0 порядок DESC + reverse, чтобы вернуть последние N до X
	// в хронологическом порядке. tail+before — равнозначно (lazy старые).
	q := `SELECT id, room, session_id, session_name, content, COALESCE(mentions, '[]'), reply_to, created_at
          FROM messages WHERE 1=1`
	args := []any{}
	if before > 0 {
		q += ` AND id < ?`
		args = append(args, before)
	} else {
		q += ` AND id > ?`
		args = append(args, since)
	}
	if room != "" {
		q += ` AND room = ?`
		args = append(args, room)
	}
	// tail=true ИЛИ before>0 → последние N (DESC + reverse в Go).
	if tail || before > 0 {
		q += ` ORDER BY id DESC LIMIT ?`
	} else {
		q += ` ORDER BY id ASC LIMIT ?`
	}
	args = append(args, limit)

	rows, err := db.Query(q, args...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	var list []Message
	var ids []int64
	for rows.Next() {
		var m Message
		var mentionsRaw string
		_ = rows.Scan(&m.ID, &m.Room, &m.SessionID, &m.SessionName, &m.Content, &mentionsRaw, &m.ReplyTo, &m.CreatedAt)
		_ = json.Unmarshal([]byte(mentionsRaw), &m.Mentions)
		list = append(list, m)
		ids = append(ids, m.ID)
	}

	// При tail=true ИЛИ before>0 БД отдала DESC (свежие первыми) —
	// переворачиваем в хронологический порядок перед отдачей клиенту.
	if tail || before > 0 {
		for i, j := 0, len(list)-1; i < j; i, j = i+1, j-1 {
			list[i], list[j] = list[j], list[i]
		}
	}

	// Прицепляем реакции (одним запросом для всех)
	rmap := loadReactions(ids)
	for i := range list {
		if rs, ok := rmap[list[i].ID]; ok {
			list[i].Reactions = rs
		}
	}

	if !threaded {
		writeJSON(w, 200, list)
		return
	}

	// Threaded mode: top-level (reply_to is null) с массивом replies.
	// Простая 2-уровневая структура — глубокие nested replies распрямляются
	// в плоский список под top-level (для MVP достаточно).
	byID := map[int64]*Message{}
	for i := range list {
		byID[list[i].ID] = &list[i]
	}
	var top []Message
	for i := range list {
		m := &list[i]
		if m.ReplyTo == nil {
			top = append(top, *m)
			continue
		}
		if parent, ok := byID[*m.ReplyTo]; ok {
			parent.Replies = append(parent.Replies, *m)
		} else {
			// родитель не в окне — показываем как top-level со ссылкой reply_to
			top = append(top, *m)
		}
	}
	// Приходится обновить ссылки на top-level (мы выше брали копии до того как заполнили Replies)
	// Перепакуем: для каждого top, найти его в byID и сделать копию final.
	final := make([]Message, 0, len(top))
	for _, t := range top {
		if p, ok := byID[t.ID]; ok {
			final = append(final, *p)
		} else {
			final = append(final, t)
		}
	}
	writeJSON(w, 200, final)
}

// GET / — chat HTML (web UI)
func handleHome(w http.ResponseWriter, r *http.Request) {
	// Локальный family-мессенджер: статика часто пересобирается, кэш браузера
	// приводил к тому что Юджин видел chat.js трёхчасовой давности после rebuild'а.
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	if r.URL.Path == "/chat.js" {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		_, _ = w.Write(chatJS)
		return
	}
	if r.URL.Path == "/chat.css" {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		_, _ = w.Write(chatCSS)
		return
	}
	if r.URL.Path == "/mobile.js" {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		_, _ = w.Write(mobileJS)
		return
	}
	if r.URL.Path == "/mobile.css" {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		_, _ = w.Write(mobileCSS)
		return
	}
	if r.URL.Path == "/m" || r.URL.Path == "/mobile" || r.URL.Path == "/mobile.html" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(mobileHTML)
		return
	}
	if r.URL.Path != "/" && r.URL.Path != "/chat" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(chatHTML)
}

// GET /api/catchup?since=ID
//
// Возвращает компактную сводку для сестры которая возвращается после
// перерыва. Не весь поток — только:
//   - count новых per-room
//   - count @mentions для текущей сессии
//   - до N highlights (предпочтение: @mentions для меня → human-сообщения → последние)
//
// Идея: при первом poll'е после долгого молчания клиент дёргает /catchup
// и показывает topbar «Пока тебя не было: 12 общ., 3 для тебя. [Развернуть]».
func handleCatchup(w http.ResponseWriter, r *http.Request) {
	s, err := authSession(r)
	if err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 20 {
		limit = 5
	}

	rows, err := db.Query(
		`SELECT id, room, session_id, session_name, content, COALESCE(mentions, '[]'), reply_to, created_at
         FROM messages WHERE id > ?
         ORDER BY id ASC`,
		since,
	)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()

	type roomStat struct {
		Count    int `json:"count"`
		Mentions int `json:"mentions"`
	}
	rooms := map[string]*roomStat{}
	var allMessages []Message
	totalNew := 0
	myMentions := 0
	myName := strings.ToLower(s.Name)

	for rows.Next() {
		var m Message
		var mentionsRaw string
		_ = rows.Scan(&m.ID, &m.Room, &m.SessionID, &m.SessionName, &m.Content, &mentionsRaw, &m.ReplyTo, &m.CreatedAt)
		_ = json.Unmarshal([]byte(mentionsRaw), &m.Mentions)
		// не учитываем СВОИ сообщения в catchup (мы их и так знаем)
		if m.SessionID == s.ID {
			continue
		}
		totalNew++
		rs, ok := rooms[m.Room]
		if !ok {
			rs = &roomStat{}
			rooms[m.Room] = rs
		}
		rs.Count++
		mine := false
		for _, mname := range m.Mentions {
			if strings.ToLower(mname) == myName {
				mine = true
				break
			}
		}
		if mine {
			rs.Mentions++
			myMentions++
		}
		allMessages = append(allMessages, m)
	}

	// Узнаём роли отправителей (человек/сестра/...) одним запросом
	senderRoles := map[string]string{}
	if len(allMessages) > 0 {
		ids := map[string]bool{}
		for _, m := range allMessages {
			ids[m.SessionID] = true
		}
		idList := make([]any, 0, len(ids))
		ph := make([]string, 0, len(ids))
		for id := range ids {
			idList = append(idList, id)
			ph = append(ph, "?")
		}
		q := `SELECT id, role FROM sessions WHERE id IN (` + strings.Join(ph, ",") + `)`
		rrows, _ := db.Query(q, idList...)
		if rrows != nil {
			for rrows.Next() {
				var id, role string
				_ = rrows.Scan(&id, &role)
				senderRoles[id] = role
			}
			rrows.Close()
		}
	}

	// Подбор highlights:
	// приоритет: my @mentions → human-сообщения → последние
	type scored struct {
		m     Message
		score int
	}
	var pool []scored
	for _, m := range allMessages {
		mine := false
		for _, mname := range m.Mentions {
			if strings.ToLower(mname) == myName {
				mine = true
				break
			}
		}
		score := 0
		if mine {
			score += 100
		}
		if senderRoles[m.SessionID] == "human" {
			score += 30
		}
		// небольшой приоритет за свежесть (большие id выше)
		score += int(m.ID / 1000)
		pool = append(pool, scored{m: m, score: score})
	}
	// Sort by score DESC, по id DESC
	for i := 0; i < len(pool); i++ {
		for j := i + 1; j < len(pool); j++ {
			if pool[j].score > pool[i].score ||
				(pool[j].score == pool[i].score && pool[j].m.ID > pool[i].m.ID) {
				pool[i], pool[j] = pool[j], pool[i]
			}
		}
	}
	highlights := []map[string]any{}
	for i := 0; i < len(pool) && i < limit; i++ {
		m := pool[i].m
		mine := false
		for _, mname := range m.Mentions {
			if strings.ToLower(mname) == myName {
				mine = true
				break
			}
		}
		// обрезка контента до 240 символов чтобы catchup был лёгким
		content := m.Content
		runes := []rune(content)
		if len(runes) > 240 {
			content = string(runes[:240]) + "…"
		}
		highlights = append(highlights, map[string]any{
			"id":           m.ID,
			"room":         m.Room,
			"session_name": m.SessionName,
			"sender_role":  senderRoles[m.SessionID],
			"content":      content,
			"is_mention":   mine,
			"created_at":   m.CreatedAt,
		})
	}

	writeJSON(w, 200, map[string]any{
		"since":       since,
		"now":         now(),
		"total_new":   totalNew,
		"my_mentions": myMentions,
		"rooms":       rooms,
		"highlights":  highlights,
	})
}

// GET /api/search?q=строка&room=NAME&limit=N
//
// Простой LIKE-search по content. Возвращает matching messages с контекстом
// (по 1 сообщению до и после). Полезно: «где недавно говорили про Battle City?»
func handleSearch(w http.ResponseWriter, r *http.Request) {
	if _, err := authSession(r); err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeErr(w, 400, "q required")
		return
	}
	if len(q) > 200 {
		q = q[:200]
	}
	room := r.URL.Query().Get("room")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 20
	}

	pattern := "%" + q + "%"
	args := []any{pattern}
	sqlQ := `SELECT id, room, session_id, session_name, content, COALESCE(mentions, '[]'), reply_to, created_at
	         FROM messages
	         WHERE content LIKE ? COLLATE NOCASE`
	if room != "" {
		sqlQ += ` AND room = ?`
		args = append(args, room)
	}
	sqlQ += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := db.Query(sqlQ, args...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()

	var hits []Message
	var ids []int64
	for rows.Next() {
		var m Message
		var mentionsRaw string
		_ = rows.Scan(&m.ID, &m.Room, &m.SessionID, &m.SessionName, &m.Content, &mentionsRaw, &m.ReplyTo, &m.CreatedAt)
		_ = json.Unmarshal([]byte(mentionsRaw), &m.Mentions)
		hits = append(hits, m)
		ids = append(ids, m.ID)
	}

	rmap := loadReactions(ids)
	for i := range hits {
		if rs, ok := rmap[hits[i].ID]; ok {
			hits[i].Reactions = rs
		}
	}

	writeJSON(w, 200, map[string]any{
		"query":   q,
		"room":    room,
		"count":   len(hits),
		"results": hits,
	})
}

// loadReactions подгружает реакции для списка message_id одним запросом и
// возвращает map[msg_id] -> []ReactionGroup (агрегированных по emoji).
func loadReactions(msgIDs []int64) map[int64][]ReactionGroup {
	out := map[int64][]ReactionGroup{}
	if len(msgIDs) == 0 {
		return out
	}
	ph := make([]string, len(msgIDs))
	args := make([]any, len(msgIDs))
	for i, id := range msgIDs {
		ph[i] = "?"
		args[i] = id
	}
	q := `SELECT r.msg_id, r.emoji, s.name FROM message_reactions r
	      LEFT JOIN sessions s ON s.id = r.session_id
	      WHERE r.msg_id IN (` + strings.Join(ph, ",") + `)
	      ORDER BY r.msg_id, r.emoji, r.created_at`
	rows, err := db.Query(q, args...)
	if err != nil {
		return out
	}
	defer rows.Close()
	// msg_id -> emoji -> ReactionGroup
	tmp := map[int64]map[string]*ReactionGroup{}
	for rows.Next() {
		var msgID int64
		var emoji, name string
		_ = rows.Scan(&msgID, &emoji, &name)
		if _, ok := tmp[msgID]; !ok {
			tmp[msgID] = map[string]*ReactionGroup{}
		}
		rg, ok := tmp[msgID][emoji]
		if !ok {
			rg = &ReactionGroup{Emoji: emoji}
			tmp[msgID][emoji] = rg
		}
		rg.Count++
		rg.Authors = append(rg.Authors, name)
	}
	for msgID, em := range tmp {
		for _, rg := range em {
			out[msgID] = append(out[msgID], *rg)
		}
	}
	return out
}

// POST /api/messages/{id}/react   {emoji}
//
// Toggle реакции: если такая (msg_id, session_id, emoji) уже есть — удаляем,
// иначе добавляем. Возвращает обновлённый список реакций для этого сообщения.
func handleReact(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, 405, "POST only")
		return
	}
	s, err := authSession(r)
	if err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}
	// path: /api/messages/{id}/react
	path := strings.TrimPrefix(r.URL.Path, "/api/messages/")
	path = strings.TrimSuffix(path, "/react")
	msgID, err := strconv.ParseInt(path, 10, 64)
	if err != nil {
		writeErr(w, 400, "bad msg id")
		return
	}
	var body struct {
		Emoji string `json:"emoji"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "bad json")
		return
	}
	body.Emoji = strings.TrimSpace(body.Emoji)
	if body.Emoji == "" {
		writeErr(w, 400, "emoji required")
		return
	}

	// Проверка что сообщение существует
	var room string
	err = db.QueryRow(`SELECT room FROM messages WHERE id = ?`, msgID).Scan(&room)
	if err != nil {
		writeErr(w, 404, "no such message")
		return
	}

	// Toggle
	res, _ := db.Exec(
		`DELETE FROM message_reactions WHERE msg_id = ? AND session_id = ? AND emoji = ?`,
		msgID, s.ID, body.Emoji,
	)
	affected, _ := res.RowsAffected()
	added := false
	if affected == 0 {
		_, err = db.Exec(
			`INSERT INTO message_reactions (msg_id, session_id, emoji, created_at) VALUES (?, ?, ?, ?)`,
			msgID, s.ID, body.Emoji, now(),
		)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		added = true
	}

	reactions := loadReactions([]int64{msgID})[msgID]

	// WS-push обновлённую запись чтобы все увидели новую реакцию мгновенно
	if hub != nil {
		envelope := struct {
			Type      string          `json:"type"`
			MessageID int64           `json:"message_id"`
			Room      string          `json:"room"`
			Reactions []ReactionGroup `json:"reactions"`
		}{Type: "reactions_updated", MessageID: msgID, Room: room, Reactions: reactions}
		data, _ := json.Marshal(envelope)
		select {
		case hub.broadcast <- broadcastEnvelope{room: room, data: data}:
		default:
		}
	}

	writeJSON(w, 200, map[string]any{
		"msg_id":    msgID,
		"emoji":     body.Emoji,
		"added":     added, // true=added, false=removed
		"reactions": reactions,
	})
}

// POST /api/uploads — multipart/form-data, field "file"
//
// Загрузка картинки (image/jpeg, image/png, image/gif, image/webp).
// Лимит: 5 MB. Ответ: {url, filename, size, mime}.
// V1 без owner-tracking в БД — только log.Printf для аудита.
const maxUploadBytes = 5 * 1024 * 1024 // 5 MB

func handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, 405, "POST only")
		return
	}
	s, err := authSession(r)
	if err != nil {
		writeErr(w, 401, "unauthorized")
		return
	}

	// hard limit на body — защита от DoS
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+64*1024)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeErr(w, 413, "file too large or invalid multipart: "+err.Error())
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, 400, "missing file field: "+err.Error())
		return
	}
	defer file.Close()

	if header.Size > maxUploadBytes {
		writeErr(w, 413, fmt.Sprintf("file too large: %d > %d", header.Size, maxUploadBytes))
		return
	}

	// Sniff MIME type by first 512 bytes
	sniff := make([]byte, 512)
	n, _ := file.Read(sniff)
	sniff = sniff[:n]
	detectedMIME := http.DetectContentType(sniff)

	allowedMIMEs := map[string]string{
		"image/jpeg": ".jpg",
		"image/png":  ".png",
		"image/gif":  ".gif",
		"image/webp": ".webp",
	}
	ext, ok := allowedMIMEs[detectedMIME]
	if !ok {
		writeErr(w, 415, "unsupported image type: "+detectedMIME)
		return
	}

	// Reset file pointer
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		writeErr(w, 500, "seek: "+err.Error())
		return
	}

	// Save to disk
	fileID := uuid.New().String()
	fileName := fileID + ext
	uploadsDir := "web/uploads"
	if err := os.MkdirAll(uploadsDir, 0755); err != nil {
		writeErr(w, 500, "mkdir uploads: "+err.Error())
		return
	}
	fullPath := filepath.Join(uploadsDir, fileName)
	out, err := os.Create(fullPath)
	if err != nil {
		writeErr(w, 500, "create file: "+err.Error())
		return
	}
	defer out.Close()

	written, err := io.Copy(out, file)
	if err != nil {
		writeErr(w, 500, "write: "+err.Error())
		return
	}

	log.Printf("[upload] %s uploaded %s (%d bytes, %s, original=%q)", s.Name, fileName, written, detectedMIME, header.Filename)

	writeJSON(w, 200, map[string]any{
		"url":      "/uploads/" + fileName,
		"filename": header.Filename,
		"size":     written,
		"mime":     detectedMIME,
	})
}

// GET /api/health — пинг для клиентов
func handleHealth(w http.ResponseWriter, r *http.Request) {
	wsClients := 0
	if hub != nil {
		hub.mu.RLock()
		wsClients = len(hub.clients)
		hub.mu.RUnlock()
	}
	writeJSON(w, 200, map[string]any{
		"ok":         true,
		"now":        now(),
		"name":       "Очаг",
		"version":    "0.2.0",
		"transport":  []string{"http-poll", "websocket"},
		"ws_clients": wsClients,
	})
}

// ─────────────────────────────────────────────────────────────
// Утилиты вывода
// ─────────────────────────────────────────────────────────────

func localIPs() []string {
	var out []string
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, a := range addrs {
		if ipnet, ok := a.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ipnet.IP.To4() != nil {
				out = append(out, ipnet.IP.String())
			}
		}
	}
	return out
}

// ─────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────

func main() {
	// БД
	var err error
	db, err = sql.Open("sqlite", dbFile)
	if err != nil {
		log.Fatal("open db:", err)
	}
	defer db.Close()
	// WAL mode: writers и readers не блокируют друг друга. Снимает write-contention
	// при concurrent ticks от sister-loops + heartbeat. busy_timeout даёт ретраи
	// вместо немедленного «database is locked» если кто-то всё же держит lock.
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
		"PRAGMA busy_timeout=5000",
	} {
		if _, err := db.Exec(pragma); err != nil {
			log.Printf("pragma warning (%s): %v", pragma, err)
		}
	}
	if _, err = db.Exec(schemaSQL); err != nil {
		log.Fatal("init schema:", err)
	}
	// Миграция: добавить next_tick_at если его нет (для существующих БД)
	if !hasColumn("sessions", "next_tick_at") {
		if _, err := db.Exec(`ALTER TABLE sessions ADD COLUMN next_tick_at INTEGER DEFAULT 0`); err != nil {
			log.Printf("migration warning (next_tick_at): %v", err)
		} else {
			log.Println("migration: added sessions.next_tick_at")
		}
	}

	// Hub для WebSocket fan-out
	hub = NewHub()
	go hub.Run()

	// Background flush для буферизированных authSession last_seen touches
	go startAuthFlushLoop(10 * time.Second)

	// Routes
	http.HandleFunc("/", handleHome)
	http.HandleFunc("/chat", handleHome)
	http.HandleFunc("/chat.js", handleHome)
	http.HandleFunc("/chat.css", handleHome)
	http.HandleFunc("/m", handleHome)
	http.HandleFunc("/mobile", handleHome)
	http.HandleFunc("/mobile.html", handleHome)
	http.HandleFunc("/mobile.js", handleHome)
	http.HandleFunc("/mobile.css", handleHome)
	http.HandleFunc("/api/health", handleHealth)
	http.HandleFunc("/api/register", handleRegister)
	http.HandleFunc("/api/sessions", handleSessions)
	http.HandleFunc("/api/heartbeat", handleHeartbeat)
	http.HandleFunc("/api/catchup", handleCatchup)
	http.HandleFunc("/api/search", handleSearch)
	http.HandleFunc("/api/rooms", handleRooms)
	http.HandleFunc("/api/messages", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			handlePostMessage(w, r)
		} else {
			handleGetMessages(w, r)
		}
	})
	http.HandleFunc("/api/messages/", func(w http.ResponseWriter, r *http.Request) {
		// /api/messages/{id}/react
		if strings.HasSuffix(r.URL.Path, "/react") {
			handleReact(w, r)
			return
		}
		http.NotFound(w, r)
	})
	http.HandleFunc("/ws", hub.handleWS)
	http.HandleFunc("/api/uploads", handleUpload)
	// Static serving for /uploads/{file} → web/uploads/{file}
	http.Handle("/uploads/", http.StripPrefix("/uploads/", http.FileServer(http.Dir("web/uploads"))))

	port := defaultPort
	if p := os.Getenv("OCHAG_PORT"); p != "" {
		if pp, err := strconv.Atoi(p); err == nil {
			port = pp
		}
	}
	addr := fmt.Sprintf("0.0.0.0:%d", port)

	fmt.Println("════════════════════════════════════════")
	fmt.Println("       🔥  ОЧАГ  —  Hydra Hearth  🔥")
	fmt.Println("════════════════════════════════════════")
	fmt.Printf("  Слушаю на :%d\n", port)
	fmt.Printf("  Локально:  http://127.0.0.1:%d/\n", port)
	for _, ip := range localIPs() {
		fmt.Printf("  Локалка:   http://%s:%d/   ← с мобилки\n", ip, port)
	}
	fmt.Println("  БД:        " + dbFile)
	fmt.Println("════════════════════════════════════════")
	fmt.Println("  Регистрация:  POST /api/register {\"name\":\"...\",\"role\":\"...\"}")
	fmt.Println("  Сообщения:    POST/GET /api/messages")
	fmt.Println("  Здоровье:     GET  /api/health")
	fmt.Println("════════════════════════════════════════")
	fmt.Println()
	fmt.Println("Из искры — пламя 🔥  Ctrl+C для остановки")
	fmt.Println()

	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal("listen:", err)
	}
}

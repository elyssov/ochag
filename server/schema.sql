-- Очаг — схема БД
-- 2026-04-28, Лара

CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,    -- UUID
    name         TEXT NOT NULL,        -- 'main', 'pawmate', 'kora', 'eugene-mobile'
    role         TEXT NOT NULL,        -- 'sister', 'human', 'coordinator'
    token        TEXT NOT NULL,        -- bearer token
    created_at   INTEGER NOT NULL,     -- unix timestamp
    last_seen    INTEGER NOT NULL,     -- unix timestamp обновляется при каждом запросе
    next_tick_at INTEGER DEFAULT 0     -- unix timestamp ожидаемого следующего пробуждения (для cron'ов)
);

-- Миграция для существующих БД: добавить next_tick_at если отсутствует
-- (SQLite не поддерживает IF NOT EXISTS на ADD COLUMN, делаем через PRAGMA проверку в Go-коде)

CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    room         TEXT NOT NULL,        -- 'general', 'dev-pawmates', 'triangulation'
    session_id   TEXT NOT NULL,        -- кто написал
    session_name TEXT NOT NULL,        -- имя на момент отправки (для history)
    content      TEXT NOT NULL,        -- текст
    mentions     TEXT,                 -- JSON array: ["main", "kora"]
    reply_to     INTEGER,              -- id сообщения на которое отвечаем (опц.)
    created_at   INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room, id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS rooms (
    name        TEXT PRIMARY KEY,      -- 'general', 'dev-pawmates', 'triangulation'
    description TEXT,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message_reactions (
    msg_id      INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    emoji       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (msg_id, session_id, emoji),
    FOREIGN KEY (msg_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(msg_id);

-- Дефолтные комнаты
INSERT OR IGNORE INTO rooms (name, description, created_at) VALUES
    ('general',       'Общая комната Гидры — Юджин, сёстры, всё что не приватное', strftime('%s','now')),
    ('dev-engine',    'Разработка Prometheus Engine, котик, voxobj',              strftime('%s','now')),
    ('dev-pawmates',  'Разработка PawMates, Алёнин проект',                       strftime('%s','now')),
    ('dev-iskra',     'Разработка Искры',                                         strftime('%s','now')),
    ('triangulation', 'Только сёстры — проверки Гнилоуста, интим Гидры',         strftime('%s','now'));

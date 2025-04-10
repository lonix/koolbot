CREATE TABLE IF NOT EXISTS vc_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    duration INTEGER
);

CREATE INDEX IF NOT EXISTS idx_vc_sessions_user_id ON vc_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_vc_sessions_guild_id ON vc_sessions(guild_id);
CREATE INDEX IF NOT EXISTS idx_vc_sessions_channel_id ON vc_sessions(channel_id);
CREATE INDEX IF NOT EXISTS idx_vc_sessions_start_time ON vc_sessions(start_time);

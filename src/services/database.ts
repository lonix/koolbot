import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

let db: any = null;

export async function initializeDatabase() {
  if (!db) {
    db = await open({
      filename: path.join(process.cwd(), 'data', 'koolbot.db'),
      driver: sqlite3.Database
    });

    // Initialize schema
    await db.exec(`
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
    `);
  }
  return db;
}

export async function startVCSession(userId: string, guildId: string, channelId: string) {
  const db = await initializeDatabase();
  const now = Date.now();
  await db.run(
    'INSERT INTO vc_sessions (user_id, guild_id, channel_id, start_time) VALUES (?, ?, ?, ?)',
    [userId, guildId, channelId, now]
  );
}

export async function endVCSession(userId: string, guildId: string, channelId: string) {
  const db = await initializeDatabase();
  const now = Date.now();
  const session = await db.get(
    'SELECT * FROM vc_sessions WHERE user_id = ? AND guild_id = ? AND channel_id = ? AND end_time IS NULL ORDER BY start_time DESC LIMIT 1',
    [userId, guildId, channelId]
  );

  if (session) {
    const duration = now - session.start_time;
    await db.run(
      'UPDATE vc_sessions SET end_time = ?, duration = ? WHERE id = ?',
      [now, duration, session.id]
    );
  }
}

export async function getVCTime(userId: string, guildId: string, period: 'today' | 'week' | 'month' | 'alltime' = 'alltime') {
  const db = await initializeDatabase();
  let query = 'SELECT SUM(duration) as total_time FROM vc_sessions WHERE user_id = ? AND guild_id = ?';
  const params: any[] = [userId, guildId];

  const now = Date.now();
  switch (period) {
    case 'today':
      query += ' AND start_time >= ?';
      params.push(now - 24 * 60 * 60 * 1000);
      break;
    case 'week':
      query += ' AND start_time >= ?';
      params.push(now - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'month':
      query += ' AND start_time >= ?';
      params.push(now - 30 * 24 * 60 * 60 * 1000);
      break;
  }

  const result = await db.get(query, params);
  return result?.total_time || 0;
}

export async function getLastSeen(userId: string, guildId: string) {
  const db = await initializeDatabase();
  const result = await db.get(
    'SELECT end_time FROM vc_sessions WHERE user_id = ? AND guild_id = ? AND end_time IS NOT NULL ORDER BY end_time DESC LIMIT 1',
    [userId, guildId]
  );
  return result?.end_time || null;
}

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const DB_PATH = process.env.DB_PATH ?? 'data/waitlist.db';
const PORT = Number(process.env.PORT ?? 9300);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000';

// Ensure data directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

// Initialize SQLite
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

const app = new Hono();

// CORS middleware on /api/*
app.use('/api/*', cors({ origin: CORS_ORIGIN }));

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/waitlist
app.post('/api/waitlist', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const raw: unknown = (body as Record<string, unknown>).email;
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';

  if (!EMAIL_REGEX.test(email)) {
    return c.json({ success: false, message: 'Invalid email address' }, 400);
  }

  const insert = db.prepare('INSERT INTO waitlist (email) VALUES (?)');

  try {
    insert.run(email);
    return c.json({ success: true, message: "You're on the list!" }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint failed')) {
      return c.json({ success: false, message: 'Already signed up!' }, 409);
    }
    throw err;
  }
});

// GET /api/waitlist
app.get('/api/waitlist', (c) => {
  const entries = db.prepare('SELECT * FROM waitlist ORDER BY created_at DESC').all();
  return c.json({ count: entries.length, entries });
});

// Start server
console.log(`Waitlist API listening on port ${PORT}`);
const server = serve({ fetch: app.fetch, port: PORT });

// Graceful shutdown
const shutdown = () => {
  db.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, server };

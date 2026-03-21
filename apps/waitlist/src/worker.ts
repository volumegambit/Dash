import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('/api/*', cors({ origin: '*' }));

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/waitlist', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const raw: unknown = (body as Record<string, unknown>).email;
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';

  if (!EMAIL_REGEX.test(email)) {
    return c.json({ success: false, message: 'Invalid email address' }, 400);
  }

  try {
    await c.env.DB.prepare('INSERT INTO waitlist (email) VALUES (?)').bind(email).run();
    return c.json({ success: true, message: "You're on the list!" }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE')) {
      return c.json({ success: false, message: 'Already signed up!' }, 409);
    }
    throw err;
  }
});

app.get('/api/waitlist', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT email, created_at FROM waitlist ORDER BY created_at DESC').all();
  return c.json({ count: results.length, entries: results });
});

export default app;

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

app.get('/dashboard', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT email, created_at FROM waitlist ORDER BY created_at DESC').all();
  const count = results.length;
  const rows = results
    .map(
      (r: Record<string, unknown>, i: number) =>
        `<tr><td>${count - i}</td><td>${r.email}</td><td>${new Date(r.created_at as string).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td></tr>`
    )
    .join('');

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Atrium Waitlist</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0A0A0A; color: #fff; font-family: 'Outfit', sans-serif; min-height: 100vh; }
    .container { max-width: 900px; margin: 0 auto; padding: 60px 24px; }
    .header { margin-bottom: 40px; }
    .label { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 3px; color: #7DD3FC; margin-bottom: 12px; }
    h1 { font-size: 36px; font-weight: 800; letter-spacing: -1px; }
    .count { display: inline-flex; align-items: center; gap: 8px; background: #7DD3FC15; border: 1px solid #7DD3FC; border-radius: 100px; padding: 6px 16px; margin-top: 16px; font-size: 14px; color: #7DD3FC; font-weight: 600; }
    .count .dot { width: 8px; height: 8px; border-radius: 50%; background: #7DD3FC; }
    table { width: 100%; border-collapse: collapse; margin-top: 32px; }
    th { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 2px; color: #555; text-align: left; padding: 12px 16px; border-bottom: 1px solid #222; }
    td { padding: 14px 16px; border-bottom: 1px solid #1A1A1A; font-size: 15px; color: #ccc; }
    tr:hover td { background: #111; }
    td:first-child { color: #555; font-family: 'JetBrains Mono', monospace; font-size: 13px; width: 60px; }
    td:nth-child(2) { color: #fff; font-weight: 600; }
    td:nth-child(3) { color: #888; font-size: 13px; }
    .empty { text-align: center; padding: 80px 0; color: #555; font-size: 18px; }
    .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 32px; }
    .logo svg { filter: drop-shadow(0 0 12px rgba(125,211,252,0.3)); }
    .logo span { font-size: 20px; font-weight: 800; letter-spacing: -0.5px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="2" y="2" width="24" height="24" rx="4" stroke="#7DD3FC" stroke-width="2" fill="none"/><line x1="2" y1="10" x2="26" y2="10" stroke="#7DD3FC" stroke-width="1.5"/><path d="M14 22C14 22 11 17 11 14C11 11 13 9 14 8C15 9 17 11 17 14C17 17 14 22 14 22Z" fill="#7DD3FC"/></svg>
      <span>atrium</span>
    </div>
    <div class="header">
      <div class="label">WAITLIST</div>
      <h1>Early Access Signups</h1>
      <div class="count"><span class="dot"></span>${count} signup${count !== 1 ? 's' : ''}</div>
    </div>
    ${count === 0
      ? '<div class="empty">No signups yet.</div>'
      : `<table><thead><tr><th>#</th><th>Email</th><th>Signed Up</th></tr></thead><tbody>${rows}</tbody></table>`
    }
  </div>
</body>
</html>`);
});

export default app;

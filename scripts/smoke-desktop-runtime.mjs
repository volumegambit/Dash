import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const resources = resolve(process.argv[2]);
const dirs = await mkdtemp(join(tmpdir(), 'dash-release-smoke-'));
const servers = await Promise.all(
  [0, 1, 2].map(
    () =>
      new Promise((r) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => r(s));
      }),
  ),
);
const ports = servers.map((s) => s.address().port);
await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
const token = randomBytes(32).toString('hex');
let log = '';
const proc = spawn(
  join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node'),
  [
    join(resources, 'apps/gateway/dist/index.js'),
    '--data-dir',
    dirs,
    '--management-port',
    String(ports[0]),
    '--channel-port',
    String(ports[1]),
    '--lan-port',
    String(ports[2]),
    '--token',
    token,
    '--chat-token',
    randomBytes(32).toString('hex'),
  ],
  {
    cwd: resources,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: process.env.TMPDIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
proc.stdout.on('data', (b) => {
  log += b;
});
proc.stderr.on('data', (b) => {
  log += b;
});
let exited = false;
proc.on('exit', () => {
  exited = true;
});
proc.on('error', (error) => {
  log += error.message;
  exited = true;
});
try {
  let health;
  for (let n = 0; n < 80 && !exited; n++) {
    try {
      const r = await fetch(`http://127.0.0.1:${ports[0]}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(300),
      });
      if (r.ok) {
        health = await r.json();
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!health)
    throw new Error(
      `Gateway did not become healthy: ${log.slice(-4500).replaceAll(token, '[redacted]')}`,
    );
  const r = await fetch(`http://127.0.0.1:${ports[0]}/models?debug=true`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Models HTTP ${r.status}`);
  const models = await r.json();
  if (!models.patterns.some((p) => p.pattern === 'gpt-6*'))
    throw new Error('GPT-6 pattern missing');
  if (!models.patterns.some((p) => p.pattern === 'kimi-k3*'))
    throw new Error('Kimi K3 pattern missing');
  console.log(
    JSON.stringify({
      health: 'ok',
      reviewedAt: models.supportedModelsReviewedAt,
      modelCount: models.models.length,
      providers: [...new Set(models.patterns.map((p) => p.provider))],
      runtime: resources,
    }),
  );
} finally {
  if (!exited) proc.kill('SIGTERM');
  for (let n = 0; n < 20 && !exited; n++) await new Promise((r) => setTimeout(r, 100));
  if (!exited) {
    proc.kill('SIGKILL');
    await new Promise((r) => proc.once('exit', r));
  }
  await rm(dirs, { recursive: true, force: true, maxRetries: 5 });
}

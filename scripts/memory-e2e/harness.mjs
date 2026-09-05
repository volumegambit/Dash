// Minimal live-gateway harness for the memory E2E smoke.
//
// These helpers are COPIED (not imported) from `scripts/plugins-e2e/run.mjs`:
// that file is a monolithic top-level script with no exports and a
// side-effectful module body — importing it would run the whole plugin suite,
// and refactoring it into a shared module would put a working E2E suite at
// risk for no functional gain. Only the boot/register/drive parts are copied;
// everything plugin-specific is left behind.
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const HOME = process.env.HOME;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Print a message and exit(2): an ENVIRONMENT problem, not a product failure. */
export function envFail(msg) {
  console.error(`memory:e2e — ENVIRONMENT: ${msg}`);
  process.exit(2);
}

/** Node >= 22.12 + real gateway credentials must exist before we boot anything. */
export async function preflight() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 12)) {
    envFail(
      `Node ${process.versions.node} is too old; the gateway needs Node >= 22.12 (undici). Try: nvm use 22.23`,
    );
  }
  try {
    await access(join(HOME, '.dash/gateway/secret.key'));
    await access(join(HOME, '.dash/gateway/credentials.enc'));
  } catch {
    envFail(
      'no gateway credentials at ~/.dash/gateway — configure a provider API key in Mission Control first.',
    );
  }
}

/**
 * $MEMORY_E2E_MODEL, else the first model in ~/.dash/gateway/agents.json —
 * the same pick the plugins smoke makes.
 */
export async function pickModel() {
  const override = process.env.MEMORY_E2E_MODEL;
  if (override) return override;
  let model;
  try {
    model = (await readFile(join(HOME, '.dash/gateway/agents.json'), 'utf8')).match(
      /"model"\s*:\s*"([^"]+)"/,
    )?.[1];
  } catch {}
  if (!model) {
    envFail(
      'no model found — set MEMORY_E2E_MODEL=provider/model-id (and ensure that provider has a key configured).',
    );
  }
  return model;
}

async function portBusy(port) {
  try {
    await (await fetch(`http://localhost:${port}/health`)).text();
    return true;
  } catch {
    return false;
  }
}

/**
 * Boot a REAL gateway under a throwaway DASH_HOME. The user's own
 * `~/.dash` is only ever READ (secret.key + credentials.enc are copied in);
 * every write the gateway makes lands under `root`, which `stop()` deletes.
 */
export async function bootGateway({
  root = join(process.env.TMPDIR || '/tmp', 'dash-memory-e2e'),
  mgmtPort = Number(process.env.MEMORY_E2E_MPORT || 19312),
  chatPort = Number(process.env.MEMORY_E2E_CPORT || 19212),
} = {}) {
  // A stale gateway already serving our port would silently intercept this run.
  if ((await portBusy(mgmtPort)) || (await portBusy(chatPort))) {
    envFail(
      `port ${mgmtPort}/${chatPort} already in use — a stale gateway may be running (pkill -f apps/gateway/src/index.ts) or set MEMORY_E2E_MPORT / MEMORY_E2E_CPORT.`,
    );
  }
  const dataDir = join(root, 'gateway');
  await rm(root, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  await copyFile(join(HOME, '.dash/gateway/secret.key'), join(dataDir, 'secret.key'));
  await copyFile(join(HOME, '.dash/gateway/credentials.enc'), join(dataDir, 'credentials.enc'));

  const log = [];
  const proc = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      join(REPO, 'apps/gateway/src/index.ts'),
      '--data-dir',
      dataDir,
      '--management-port',
      String(mgmtPort),
      '--channel-port',
      String(chatPort),
      '--verbose',
    ],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DASH_HOME: root } },
  );
  proc.stdout.on('data', (d) => log.push(d.toString()));
  proc.stderr.on('data', (d) => log.push(d.toString()));

  const gw = {
    root,
    dataDir,
    mgmtUrl: `http://localhost:${mgmtPort}`,
    chatUrl: `ws://localhost:${chatPort}/ws/chat`,
    log,
    tail: (n = 30) => log.join('').split('\n').slice(-n).join('\n'),
    async stop() {
      proc.kill('SIGTERM');
      await sleep(300);
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${gw.mgmtUrl}/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(500);
  }
  if (!ready) {
    await gw.stop();
    throw new Error(`gateway did not become ready:\n${log.join('')}`);
  }
  await sleep(500);
  return gw;
}

/** POST /agents. Management auth is off in this harness (no MANAGEMENT_API_TOKEN). */
export async function registerAgent(gw, config) {
  const res = await fetch(`${gw.mgmtUrl}/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`agent registration failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

/** PATCH /agents/:id/memory/config — `{ enabled?, sweep? }`. */
export async function setMemoryConfig(gw, agentId, body) {
  const res = await fetch(`${gw.mgmtUrl}/agents/${agentId}/memory/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`memory config patch failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

/**
 * Drive one chat turn over the WebSocket and collect every AgentEvent.
 * Resolves `{ text, events, error?, timedOut? }` — `text` is the final
 * assistant response. Never rejects; callers assert on the shape.
 */
export function driveTurn(gw, agentId, conversationId, text, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(gw.chatUrl);
    const events = [];
    const id = `req-${Math.random().toString(36).slice(2)}`;
    const close = () => {
      try {
        ws.close();
      } catch {}
    };
    const timer = setTimeout(() => {
      close();
      resolve({ text: replyText(events), events, timedOut: true });
    }, timeoutMs);
    const settle = (extra) => {
      clearTimeout(timer);
      close();
      resolve({ text: replyText(events), events, ...extra });
    };
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: 'message',
          id,
          agentId,
          channelId: 'direct',
          conversationId,
          text,
        }),
      );
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data.toString());
      } catch {
        return;
      }
      if (m.id && m.id !== id) return;
      if (m.type === 'event') events.push(m.event);
      else if (m.type === 'done') settle({});
      else if (m.type === 'error') settle({ error: m.error });
    };
    ws.onerror = () => settle({ error: 'ws connect error' });
  });
}

/** The assistant's final text for a turn (last `response` event, else streamed text). */
export function replyText(events) {
  const responses = events.filter((e) => e.type === 'response');
  if (responses.length) return String(responses[responses.length - 1].content ?? '');
  return events
    .filter((e) => e.type === 'text_delta')
    .map((e) => e.text ?? '')
    .join('');
}

/** One-line trace of a turn's tool calls + memory events, for the run log. */
export function describeTurn(turn) {
  const lines = [];
  for (const e of turn.events) {
    if (e.type === 'tool_use_start')
      lines.push(`     → CALL   ${e.name}  ${JSON.stringify(e.input || {}).slice(0, 160)}`);
    else if (e.type === 'tool_result')
      lines.push(`     ← RESULT ${(e.content || '').replace(/\s+/g, ' ').slice(0, 160)}`);
    else if (e.type === 'memory_saved')
      lines.push(`     ★ EVENT  memory_saved name=${e.name} type=${e.memoryType} ${e.action}`);
    else if (e.type === 'memory_forgotten')
      lines.push(`     ★ EVENT  memory_forgotten name=${e.name}`);
  }
  lines.push(`     ↩ REPLY  ${turn.text.replace(/\s+/g, ' ').slice(0, 240)}`);
  return lines.join('\n');
}

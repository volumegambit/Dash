#!/usr/bin/env node
// Local end-to-end smoke test against a REAL gateway through a REAL relay.
//
// Spawns:
//   1. the relay   (apps/relay/src/main.ts)
//   2. the gateway (apps/gateway/src/index.ts) in relay mode, against a
//      throwaway data dir
// then drives phone-style traffic at the relay's public edge (Host
// <gatewayId>.localhost) and asserts it round-trips to the gateway and back.
//
// Unlike the in-process vitest e2e (apps/gateway/src/relay-e2e.test.ts), this
// boots the actual gateway process, so it exercises real auth, real routing, and
// the real WS upgrade path. It deliberately avoids anything that needs an LLM
// (no agents are configured), so it is deterministic and credential-free.
//
// Both processes run from source via `tsx` — the same way `npm run gateway` and
// `npm run relay` launch them — so no build step is required. Run with
// `node scripts/relay-e2e.mjs` (Node 22.12+ for undici).

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELAY_PORT = 18443;
const MGMT_PORT = 19300;
const CHAT_PORT = 19200;
const GATEWAY_ID = 'e2e';
const RELAY_TOKEN = 'dev-relay-token';
const MGMT_TOKEN = 'dev-mgmt-token';
const CHAT_TOKEN = 'dev-chat-token';
const PHONE_HOST = `${GATEWAY_ID}.localhost`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Phone-style HTTP request through the relay edge (sets the routing Host). */
function phoneRequest(path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: RELAY_PORT,
        path,
        method: 'GET',
        headers: { host: PHONE_HOST, ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll /health through the relay until the gateway has registered and replies. */
async function waitForGateway(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { status } = await phoneRequest('/health');
      if (status === 200) return true;
    } catch {
      // relay or gateway not up yet
    }
    await sleep(250);
  }
  return false;
}

function waitForExit(child) {
  return new Promise((resolve) => child.on('exit', () => resolve()));
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'dash-relay-e2e-'));
  const node = process.execPath;
  const children = [];
  const log = (name) => (buf) => {
    const line = buf.toString().trim();
    if (line) console.log(`    [${name}] ${line}`);
  };

  // 1. Relay (from source via tsx, like `npm run relay`)
  const relay = spawn(
    node,
    [
      '--import',
      'tsx',
      join(ROOT, 'apps/relay/src/main.ts'),
      '--port',
      String(RELAY_PORT),
      '--relay-token',
      RELAY_TOKEN,
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  relay.stdout.on('data', log('relay'));
  relay.stderr.on('data', log('relay'));
  children.push(relay);

  // 2. Gateway in relay mode (from source via tsx, throwaway data dir, no agents)
  const gateway = spawn(
    node,
    [
      '--import',
      'tsx',
      join(ROOT, 'apps/gateway/src/index.ts'),
      '--management-port',
      String(MGMT_PORT),
      '--channel-port',
      String(CHAT_PORT),
      '--token',
      MGMT_TOKEN,
      '--chat-token',
      CHAT_TOKEN,
      '--data-dir',
      dataDir,
      '--relay-url',
      `ws://127.0.0.1:${RELAY_PORT}`,
      '--relay-token',
      RELAY_TOKEN,
      '--gateway-id',
      GATEWAY_ID,
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production' },
    },
  );
  gateway.stdout.on('data', log('gateway'));
  gateway.stderr.on('data', log('gateway'));
  children.push(gateway);

  let registered = false;
  try {
    console.log('\nWaiting for the gateway to register at the relay...');
    registered = await waitForGateway();
    check('gateway registers at the relay and answers /health', registered);
    if (!registered) return;

    console.log('\nDriving phone traffic through the relay edge:');

    // /health is auth-exempt — proves the HTTP round-trip end to end.
    const health = await phoneRequest('/health');
    let healthy = false;
    try {
      healthy = JSON.parse(health.body).status === 'healthy';
    } catch {
      healthy = false;
    }
    check('GET /health -> 200 healthy', health.status === 200 && healthy, `HTTP ${health.status}`);

    // /agents with the right Bearer -> 200 JSON list (empty: no agents).
    const agentsOk = await phoneRequest('/agents', {
      headers: { authorization: `Bearer ${MGMT_TOKEN}` },
    });
    let isArray = false;
    try {
      isArray = Array.isArray(JSON.parse(agentsOk.body));
    } catch {
      isArray = false;
    }
    check(
      'GET /agents (valid Bearer) -> 200 JSON array',
      agentsOk.status === 200 && isArray,
      `HTTP ${agentsOk.status}`,
    );

    // Wrong Bearer -> 401, proving the gateway's auth runs end to end (the relay
    // forwards the token verbatim and does not authenticate on its behalf).
    const agentsBad = await phoneRequest('/agents', { headers: { authorization: 'Bearer wrong' } });
    check('GET /agents (bad Bearer) -> 401', agentsBad.status === 401, `HTTP ${agentsBad.status}`);

    // WS chat upgrade with the right token -> opens.
    const wsOk = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws/chat?token=${CHAT_TOKEN}`, {
        headers: { host: PHONE_HOST },
      });
      const timer = setTimeout(() => {
        ws.terminate();
        resolve(false);
      }, 5000);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      });
      ws.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    check('WS /ws/chat (valid token) -> upgraded', wsOk);

    // WS chat upgrade with a bad token -> gateway closes 4001, propagated to the
    // phone through the relay.
    const wsCloseCode = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws/chat?token=wrong`, {
        headers: { host: PHONE_HOST },
      });
      const timer = setTimeout(() => {
        ws.terminate();
        resolve(0);
      }, 5000);
      ws.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      ws.on('error', () => {});
    });
    check('WS /ws/chat (bad token) -> close 4001', wsCloseCode === 4001, `code ${wsCloseCode}`);
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await Promise.race([Promise.all(children.map(waitForExit)), sleep(3000)]);
    for (const child of children) child.kill('SIGKILL');
    await rm(dataDir, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failed check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('relay-e2e crashed:', err);
  process.exit(1);
});

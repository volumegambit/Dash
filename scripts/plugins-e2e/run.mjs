// Plugin functional E2E smoke.
//
// Boots a REAL gateway with a self-contained demo plugin (skills/, commands/,
// bin/, .mcp.json → a bundled fixture MCP server, hooks/ → a PreToolUse block,
// agents/ → a loadable specialist), registers an agent, drives six prompts over
// the chat WebSocket, and asserts that each plugin component actually triggers
// the right tool / skill / hook — covering plugin Plans 1-4. Fully isolated
// under a temp DASH_HOME; real provider credentials are copied in and deleted
// on teardown.
//
// Run: npm run plugins:e2e   (Node >= 22.12 required — the gateway needs it)
// Model: $PLUGINS_E2E_MODEL, else the first model from ~/.dash/gateway/agents.json.
// Prereq: a provider API key configured in the gateway (~/.dash/gateway).
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const HOME = process.env.HOME;
const ROOT = join(process.env.TMPDIR || '/tmp', 'dash-plugins-e2e');
const DATA = join(ROOT, 'gateway');
const MPORT = Number(process.env.PLUGINS_E2E_MPORT || 19302);
const CPORT = Number(process.env.PLUGINS_E2E_CPORT || 19202);
const FIXTURE = join(HERE, 'fixture-mcp-server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`plugins:e2e — ${msg}`);
  process.exit(2);
};

// --- Preconditions ---------------------------------------------------------
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 12))
  fail(
    `Node ${process.versions.node} is too old; the gateway needs Node >= 22.12 (undici). Try: nvm use 22.23`,
  );
try {
  await access(join(HOME, '.dash/gateway/secret.key'));
  await access(join(HOME, '.dash/gateway/credentials.enc'));
} catch {
  fail(
    'no gateway credentials at ~/.dash/gateway — configure a provider API key in Mission Control first.',
  );
}
let MODEL = process.env.PLUGINS_E2E_MODEL;
if (!MODEL) {
  try {
    MODEL = (await readFile(join(HOME, '.dash/gateway/agents.json'), 'utf8')).match(
      /"model"\s*:\s*"([^"]+)"/,
    )?.[1];
  } catch {}
}
if (!MODEL)
  fail(
    'no model found — set PLUGINS_E2E_MODEL=provider/model-id (and ensure that provider has a key configured).',
  );
// A stale gateway already serving our port would silently intercept this run.
const portBusy = async (port) => {
  try {
    await (await fetch(`http://localhost:${port}/health`)).text();
    return true;
  } catch {
    return false;
  }
};
if ((await portBusy(MPORT)) || (await portBusy(CPORT)))
  fail(
    `port ${MPORT}/${CPORT} already in use — a stale gateway may be running (pkill -f apps/gateway/src/index.ts) or set PLUGINS_E2E_MPORT / PLUGINS_E2E_CPORT.`,
  );

let gw;
const gwlog = [];
try {
  // --- 1. Isolated dataDir + self-contained demo plugin + copied creds -----
  await rm(ROOT, { recursive: true, force: true });
  for (const d of [
    'plugins/demo/.claude-plugin',
    'plugins/demo/skills/greet',
    'plugins/demo/commands',
    'plugins/demo/bin',
    'plugins/demo/agents',
    'plugins/demo/hooks',
  ])
    await mkdir(join(DATA, d), { recursive: true });
  await writeFile(
    join(DATA, 'plugins/demo/.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'demo', version: '0.1.0' }),
  );
  await writeFile(
    join(DATA, 'plugins/demo/skills/greet/SKILL.md'),
    '---\nname: greet\ndescription: Greet the user warmly in one short sentence\n---\nGreet the user warmly in one sentence.',
  );
  await writeFile(
    join(DATA, 'plugins/demo/commands/triage.md'),
    '---\ndescription: Triage an incoming issue and propose next steps\n---\nSummarize the issue in one line and list two next steps.',
  );
  await writeFile(
    join(DATA, 'plugins/demo/bin/demo-tool'),
    '#!/usr/bin/env bash\necho "demo-tool ran"\n',
  );
  await import('node:fs/promises').then((fs) =>
    fs.chmod(join(DATA, 'plugins/demo/bin/demo-tool'), 0o755),
  );
  await writeFile(
    join(DATA, 'plugins/demo/.mcp.json'),
    JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [FIXTURE] } } }),
  );
  // agents/ → a loadable specialist (Plan 4), namespaced demo:reviewer
  await writeFile(
    join(DATA, 'plugins/demo/agents/reviewer.md'),
    '---\nname: reviewer\ndescription: A meticulous code reviewer specialist. Use when asked to review code.\n---\nYou are the DEMO reviewer specialist. Begin every reply with "DEMO-REVIEWER-OK" then a one-line review.',
  );
  // hooks/ → a PreToolUse hook (Plan 3) that blocks a matched bash call ONLY
  // when the command contains the DENYME sentinel (so the bin/ test, which runs
  // demo-tool via bash, is unaffected). Exit 2 → block; stderr → deny reason.
  await writeFile(
    join(DATA, 'plugins/demo/hooks/hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'bash',
            hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/block.js' }],
          },
        ],
      },
    }),
  );
  await writeFile(
    join(DATA, 'plugins/demo/hooks/block.js'),
    "let d='';process.stdin.on('data',(c)=>{d+=c;});process.stdin.on('end',()=>{if(d.includes('DENYME')){process.stderr.write('DEMO-BLOCK: bash denied by demo hook.');process.exit(2);}process.exit(0);});\n",
  );
  await writeFile(
    join(DATA, 'plugins/config.json'),
    JSON.stringify({ demo: { enabled: true, trusted: true } }),
  );
  await copyFile(join(HOME, '.dash/gateway/secret.key'), join(DATA, 'secret.key'));
  await copyFile(join(HOME, '.dash/gateway/credentials.enc'), join(DATA, 'credentials.enc'));

  // --- 2. Spawn the gateway (same node), DASH_HOME isolated ----------------
  console.log(`plugins:e2e — model=${MODEL}  node=${process.versions.node}`);
  gw = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      join(REPO, 'apps/gateway/src/index.ts'),
      '--data-dir',
      DATA,
      '--management-port',
      String(MPORT),
      '--channel-port',
      String(CPORT),
      '--verbose',
    ],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DASH_HOME: ROOT } },
  );
  gw.stdout.on('data', (d) => gwlog.push(d.toString()));
  gw.stderr.on('data', (d) => gwlog.push(d.toString()));

  // --- 3. Wait for ready, let the plugin's MCP server connect --------------
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${MPORT}/health`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(500);
  }
  if (!ready) throw new Error(`gateway did not become ready:\n${gwlog.join('')}`);
  await sleep(1500);
  console.log('\n--- gateway startup (plugin + MCP) ---');
  console.log(
    gwlog
      .join('')
      .split('\n')
      .filter((l) => /\[plugins\]|\[mcp:demo-fixture\]|added at runtime/.test(l))
      .map((l) => `  ${l.replace(/^.*\] \[gateway\] /, '')}`)
      .join('\n'),
  );

  // --- 4. Register the test agent ------------------------------------------
  const reg = await fetch(`http://localhost:${MPORT}/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'plugins-e2e',
      model: MODEL,
      systemPrompt:
        'You are a terse test agent. When asked to run a tool or load a skill, do it directly with no preamble.',
      tools: ['bash', 'mcp'],
      mcpServers: ['demo-fixture'],
    }),
  });
  if (!reg.ok) throw new Error(`agent registration failed: ${reg.status} ${await reg.text()}`);
  const agentId = (await reg.json()).id;
  console.log(`registered agent id=${agentId}\n`);

  // --- 5. Chat helper (fresh conversation per prompt) ----------------------
  const chat = (text, conv) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${CPORT}/ws/chat`);
      const events = [];
      const id = `req-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        resolve({ events, timedOut: true });
      }, 120000);
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            type: 'message',
            id,
            agentId,
            channelId: 'direct',
            conversationId: conv,
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
        else if (m.type === 'done') {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          resolve({ events });
        } else if (m.type === 'error') {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          resolve({ events, error: m.error });
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve({ events, error: 'ws connect error' });
      };
    });

  // --- 6. Prompt matrix: one component per prompt --------------------------
  const tres = (ev, re) =>
    ev.find((e) => e.type === 'tool_result' && re.test(e.content || ''))?.content;
  const tests = [
    [
      'bin/      trusted plugin bin/ on PATH (bash runs demo-tool)',
      'Use your bash tool to run exactly this command and report its output verbatim: demo-tool',
      (ev) =>
        ev.some((e) => e.type === 'tool_use_start' && e.name === 'bash') &&
        !!tres(ev, /demo-tool ran/),
      (ev) => tres(ev, /demo-tool ran/),
    ],
    [
      '.mcp.json trusted plugin MCP tool invoked (demo-fixture__echo)',
      "Call your MCP tool named demo-fixture__echo with text 'hello-from-e2e' and report exactly what it returns.",
      (ev) =>
        ev.some((e) => e.type === 'tool_use_start' && /^demo-fixture__echo/.test(String(e.name))) &&
        !!tres(ev, /echo: hello-from-e2e/),
      (ev) => tres(ev, /echo: hello-from-e2e/),
    ],
    [
      'skills/   plugin skill loaded (greet body delivered)',
      "Use your load_skill tool to load the skill named 'greet', then follow it.",
      (ev) =>
        ev.some((e) => e.type === 'tool_use_start' && e.name === 'load_skill') &&
        !!tres(ev, /Greet the user warmly/),
      (ev) => tres(ev, /Greet the user warmly/),
    ],
    [
      'commands/ plugin command loaded as skill (demo:triage body delivered)',
      "Use your load_skill tool to load the skill named 'demo:triage', then apply it to: the login page returns a 500 error.",
      (ev) =>
        ev.some((e) => e.type === 'tool_use_start' && e.name === 'load_skill') &&
        !!tres(ev, /Summarize the issue/),
      (ev) => tres(ev, /Summarize the issue/),
    ],
    [
      'agents/   plugin agent specialist loaded (demo:reviewer body delivered)',
      "Use your load_skill tool to load the skill named 'demo:reviewer', then review this code: function f(){return 1}",
      (ev) =>
        ev.some((e) => e.type === 'tool_use_start' && e.name === 'load_skill') &&
        !!tres(ev, /DEMO-REVIEWER-OK/),
      (ev) => tres(ev, /DEMO-REVIEWER-OK/),
    ],
    [
      'hooks/    PreToolUse hook blocks a matched bash call (deny reason surfaced)',
      'Use your bash tool to run exactly this command: echo DENYME',
      (ev) =>
        ev.some((e) => e.type === 'tool_use_start' && e.name === 'bash') &&
        !!tres(ev, /DEMO-BLOCK/),
      (ev) => tres(ev, /DEMO-BLOCK/),
    ],
  ];

  console.log('=== prompt matrix (real LLM calls) ===');
  let pass = 0;
  for (const [name, prompt, check, evidence] of tests) {
    const { events, error, timedOut } = await chat(
      prompt,
      `c-${Math.random().toString(36).slice(2)}`,
    );
    const ok = !error && !timedOut && check(events);
    if (ok) pass++;
    console.log(`\n${ok ? '✅ PASS' : '❌ FAIL'}  ${name}`);
    if (error) console.log('   ws error:', error);
    if (timedOut) console.log('   (timed out)');
    for (const e of events) {
      if (e.type === 'tool_use_start')
        console.log(`     → CALL   ${e.name}  ${JSON.stringify(e.input || {}).slice(0, 140)}`);
      else if (e.type === 'tool_result')
        console.log(`     ← RESULT ${(e.content || '').replace(/\s+/g, ' ').slice(0, 180)}`);
    }
    if (!ok) {
      const ev = evidence(events);
      if (ev) console.log('   (got:', String(ev).slice(0, 120), ')');
    }
  }
  console.log(`\n========== ${pass}/${tests.length} plugin components triggered ==========`);
  process.exitCode = pass === tests.length ? 0 : 1;
} catch (err) {
  console.error('\nplugins:e2e — HARNESS ERROR:', err.message);
  console.error(`--- last gateway log ---\n${gwlog.join('').split('\n').slice(-30).join('\n')}`);
  process.exitCode = 1;
} finally {
  if (gw) gw.kill('SIGTERM');
  await sleep(300);
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
}

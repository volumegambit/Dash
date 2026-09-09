// Prepare an isolated DASH_HOME so Mission Control can run TEST_PLAN §32 live.
//
// `TEST_PLAN.md` §32 needs a REAL provider credential and an agent with
// sub-agents enabled, in a data tree that is NOT the user's `~/.dash`. This
// script builds exactly that, using the sanctioned harness
// (`scripts/memory-e2e/harness.mjs`): `bootGateway` copies
// `~/.dash/gateway/{secret.key,credentials.enc}` into the throwaway root
// IN-PROCESS — the user's `~/.dash` is only ever READ — and the whole root is
// deleted by the caller on teardown.
//
// It then registers one agent (sub-agents on, depth 2 so §32.3.5's grandchild
// is possible) against that gateway, which persists it to
// `<root>/gateway/agents.json`, and SHUTS THE HARNESS GATEWAY DOWN, leaving the
// populated tree behind. Mission Control is launched afterwards with
// `DASH_HOME=<root>` so ITS OWN supervisor spawns the gateway (from
// `apps/gateway/dist`, with its own keychain token) over the same `--data-dir`.
// Two gateways never run over the tree at once.
//
// Run:  node scripts/subagents-e2e/boot-for-mc.mjs [--root DIR] [--model ID]
// Then: DASH_HOME=<root> MC_GATEWAY_MANAGEMENT_PORT=... npm run mc:dev:debug
// Teardown: rm -rf <root>
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bootGateway, envFail, pickModel, preflight, sleep } from '../memory-e2e/harness.mjs';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') out.root = argv[++i];
    else if (argv[i] === '--model') out.model = argv[++i];
  }
  return out;
}

/** A real git repo with subdirectories, so "list files in a subdirectory" has work to do. */
async function makeWorkspace(root) {
  const dir = join(root, 'workspace');
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, '.gitignore'), 'docs/plans/\nnode_modules/\n');
  await writeFile(join(dir, 'README.md'), '# mc x1 workspace\n');
  await writeFile(join(dir, 'src/alpha.ts'), 'export const alpha = 1;\n');
  await writeFile(join(dir, 'src/beta.ts'), 'export const beta = 2;\n');
  await writeFile(join(dir, 'src/gamma.ts'), 'export const gamma = 3;\n');
  await writeFile(join(dir, 'docs/one.md'), '# one\n');
  await writeFile(join(dir, 'docs/two.md'), '# two\n');
  const git = (...args) => execFileAsync('git', ['-C', dir, ...args]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'e2e@example.invalid');
  await git('config', 'user.name', 'mc x1');
  await git('add', '-A');
  await git('commit', '-qm', 'workspace fixture');
  return dir;
}

const args = parseArgs(process.argv.slice(2));
const root = args.root || join(process.env.TMPDIR || '/tmp', 'dash-mc-x1');
const mgmtPort = Number(process.env.MC_X1_BOOT_MPORT || 19352);
const chatPort = Number(process.env.MC_X1_BOOT_CPORT || 19252);

await preflight();
const model = args.model || process.env.SUBAGENTS_E2E_MODEL || (await pickModel());

console.log(`\n========== boot-for-mc  model=${model}  root=${root} ==========\n`);

const gw = await bootGateway({ root, mgmtPort, chatPort });

let health;
try {
  const workspace = await makeWorkspace(root);
  const res = await fetch(`${gw.mgmtUrl}/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'x1-subagents',
      model,
      workspace,
      systemPrompt:
        'You are a terse test orchestrator. Do exactly what you are asked with the ' +
        'tools you are given, then answer in one or two short sentences.',
      subagents: { delegation: 'auto', maxConcurrent: 4, maxPerTurn: 6, maxDepth: 2 },
    }),
  });
  if (!res.ok) {
    throw new Error(`agent registration failed: ${res.status} ${await res.text()}`);
  }
  const agent = await res.json();
  health = await (await fetch(`${gw.mgmtUrl}/health`)).json();
  console.log(`workspace  ${workspace}`);
  console.log(`agent      ${agent.id} (${agent.name ?? 'x1-subagents'})`);
} catch (err) {
  await gw.stop();
  envFail(String(err instanceof Error ? err.message : err));
}

// Hand the tree over: stop the harness gateway WITHOUT deleting the root, and
// wait until both ports are genuinely free. MC's `portOwnerProbe` must see
// `free`; a dying listener reads as `unknown` and it refuses to start.
process.kill(health.pid, 'SIGTERM');
const free = async (port) => {
  try {
    await fetch(`http://localhost:${port}/health`);
    return false;
  } catch {
    return true;
  }
};
for (let i = 0; i < 60; i++) {
  if ((await free(mgmtPort)) && (await free(chatPort))) break;
  await sleep(250);
}
if (!((await free(mgmtPort)) && (await free(chatPort)))) {
  envFail(`harness gateway pid ${health.pid} did not release ${mgmtPort}/${chatPort}`);
}

console.log(`\nDASH_HOME ready: ${root}`);
console.log(`  data dir   ${join(root, 'gateway')} (secret.key + credentials.enc copied in)`);
console.log(`  model      ${model}`);
console.log('\nLaunch Mission Control against it with:');
console.log(
  `  DASH_HOME=${root} DASH_CONTROL_PLANE_URL= MC_GATEWAY_MANAGEMENT_PORT=19340 MC_GATEWAY_CHANNEL_PORT=19240 MC_GATEWAY_LAN_PORT=19440 MC_DEBUG_PORT=9333 npm run mc:dev:debug`,
);
console.log(`\nTeardown:  rm -rf ${root}\n`);

// Capture REAL gateway frame streams as contract fixtures (Task E3-x1, D4/D2/D5).
//
// WHY THIS EXISTS. Three clients each grew a sub-agent fold against
// hand-written event lists, and all three agreed with each other and with
// nothing the gateway actually sends. D4 is the proof: `groupSubagentEvents`
// clusters two spawns only when nothing but sub-agent chrome sits between
// their anchors, and whether a real spawn puts something there depends on a
// RACE no synthetic fixture models.
//
// So this script drives a REAL gateway with a REAL model and writes the frames
// it receives, verbatim, into `contracts/mobile/v1/fixtures/`:
//
//   subagent-parallel-frames.jsonl      one turn, two FOREGROUND `agent` calls
//   subagent-background-pair-frames.jsonl  one turn, two BACKGROUND `agent` calls (D4)
//   subagent-notification-frames.jsonl  a background child + the server-initiated
//                                       notification turn that follows it (D2)
//   subagent-progress-frames.jsonl      a foreground child that outlives one
//                                       10s heartbeat, so the stream carries the
//                                       TRANSIENT `subagent_progress` frames the
//                                       hub broadcasts with NO `seq` (D5)
//
// The two parallel captures are BOTH kept because they disagree, and the
// disagreement is the finding: with two foreground calls the children's
// `tool_result`s land after both `subagent_started`s and §8.2's container
// renders, while two background calls put each child's immediate
// "launched in the background" `tool_result` BETWEEN the anchors and split the
// cluster. D4 is that race, not the structural impossibility it was filed as.
//
// Both are `MobileWsServerFrame` JSONL, the same shape as the existing
// `subagent-events.jsonl`, so `contracts/mobile/v1`'s manifest test and iOS's
// `DashContractTests` validate every captured frame against the schema.
//
// ISOLATION. Identical to `run.mjs` / `boot-for-mc.mjs`: `bootGateway` copies
// `~/.dash/gateway/{secret.key,credentials.enc}` into a throwaway root
// IN-PROCESS — your own `~/.dash` is only ever READ — and the whole root is
// deleted on teardown. Ports default to 19362/19262 so it cannot collide with
// `run.mjs` (19332/19232), `boot-for-mc.mjs` (19352/19252) or the user's
// launchd gateway (9410/9210).
//
// COST. Real LLM calls: two parent turns plus their children, a few cents.
// Not part of `npm test` / CI. Run it by hand when the gateway's event
// ORDERING changes, and commit the result.
//
// Run: node scripts/subagents-e2e/capture-fixtures.mjs [--model ID] [--out DIR]
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  bootGateway,
  envFail,
  pickModel,
  preflight,
  registerAgent,
} from '../memory-e2e/harness.mjs';

const execFileAsync = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..');

const TURN_MS = Number(process.env.CAPTURE_TURN_MS || 300_000);
const NOTIFY_MS = Number(process.env.CAPTURE_NOTIFY_MS || 240_000);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') out.model = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--only') out.only = new Set(argv[++i].split(',').map((s) => s.trim()));
  }
  return out;
}

const rand = () => Math.random().toString(36).slice(2, 10);
// Frame correlation ids are UUIDs because `chat-ws.schema.json` says so and a
// REAL client obeys it. A capture that invents `req-<slug>` ids produces a
// stream no schema will validate, which is a defect in the recorder, not in
// the gateway that faithfully echoes whatever id it was handed.
const frameId = () => randomUUID();

/** A socket that keeps EVERY frame, across `done`, so a notification turn lands in the same buffer. */
async function openWatcher(gw) {
  const frames = [];
  const listeners = new Set();
  const ws = new WebSocket(gw.chatUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`could not connect to ${gw.chatUrl}`));
  });
  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data.toString());
    } catch {
      return;
    }
    frames.push(m);
    for (const listener of [...listeners]) listener();
  };
  const waitFor = (pred, timeoutMs) =>
    new Promise((resolve) => {
      const probe = () => {
        const value = pred(frames);
        if (value) settle(value);
      };
      const timer = setTimeout(() => {
        listeners.delete(probe);
        resolve(undefined);
      }, timeoutMs);
      const settle = (value) => {
        clearTimeout(timer);
        listeners.delete(probe);
        resolve(value);
      };
      listeners.add(probe);
      probe();
    });
  const send = (frame) => ws.send(JSON.stringify(frame));
  return {
    frames,
    waitFor,
    subscribe(agentId, conversationId) {
      send({ type: 'subscribe', id: frameId(), agentId, conversationId });
    },
    async drive(agentId, conversationId, text, timeoutMs = TURN_MS) {
      const id = frameId();
      send({
        type: 'message',
        id,
        agentId,
        channelId: 'direct',
        conversationId,
        text,
        resumable: true,
      });
      const end = await waitFor(
        (fs) => fs.find((f) => f.id === id && (f.type === 'done' || f.type === 'error')),
        timeoutMs,
      );
      return { id, end, timedOut: end === undefined };
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

async function newConversation(gw, agentId, title) {
  const res = await fetch(`${gw.mgmtUrl}/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId, requestId: `cap-${rand()}`, title }),
  });
  if (!res.ok) throw new Error(`conversation create failed: ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

async function makeWorkspace(root) {
  const dir = join(root, 'workspace');
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'README.md'), '# capture workspace\n');
  await writeFile(join(dir, 'src/alpha.ts'), 'export const alpha = 1;\n');
  await writeFile(join(dir, 'src/beta.ts'), 'export const beta = 2;\n');
  await writeFile(join(dir, 'docs/one.md'), '# one\n');
  const git = (...args) => execFileAsync('git', ['-C', dir, ...args]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'e2e@example.invalid');
  await git('config', 'user.name', 'capture');
  await git('add', '-A');
  await git('commit', '-qm', 'workspace fixture');
  return dir;
}

/** Frames for `ids`, in arrival order, with nothing edited. */
const framesFor = (frames, ids) => frames.filter((f) => ids.includes(f.id));

function summarise(label, frames) {
  console.log(`\n--- ${label} (${frames.length} frames) ---`);
  for (const f of frames) {
    const seq = 'seq' in f && f.seq !== undefined ? `seq=${f.seq}` : 'NO-SEQ';
    if (f.type === 'event') {
      const e = f.event ?? {};
      const extra =
        e.type === 'tool_use_start' || e.type === 'tool_result'
          ? ` name=${e.name}`
          : e.subagentId
            ? ` ${String(e.subagentId).slice(0, 12)}`
            : '';
      console.log(`  ${seq.padEnd(8)} event ${e.type}${extra}`);
    } else {
      console.log(`  ${seq.padEnd(8)} ${f.type}${f.origin ? ` origin=${f.origin}` : ''}`);
    }
  }
  const noSeq = frames.filter((f) => f.type === 'event' && f.seq === undefined);
  if (noSeq.length) {
    console.log(
      `  ⚠  ${noSeq.length} event frame(s) carry NO seq (transient, spec §7.2): ` +
        `${[...new Set(noSeq.map((f) => f.event?.type))].join(', ')}`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const out = args.out || join(REPO, 'contracts/mobile/v1/fixtures');
const root = join(process.env.TMPDIR || '/tmp', 'dash-subagents-capture');
const mgmtPort = Number(process.env.CAPTURE_MPORT || 19362);
const chatPort = Number(process.env.CAPTURE_CPORT || 19262);

await preflight();
const model = args.model || process.env.SUBAGENTS_E2E_MODEL || (await pickModel());
console.log(`\n========== capture-fixtures  model=${model}  root=${root} ==========\n`);

const gw = await bootGateway({ root, mgmtPort, chatPort });
try {
  const workspace = await makeWorkspace(root);
  const agent = await registerAgent(gw, {
    name: 'capture-subagents',
    model,
    workspace,
    systemPrompt:
      'You are a terse test orchestrator. Do exactly what you are asked with the tools ' +
      'you are given, then answer in ONE short sentence. Never list file contents.',
    subagents: { delegation: 'auto', maxConcurrent: 4, maxPerTurn: 6, maxDepth: 2 },
  });
  console.log(`agent ${agent.id}  workspace ${workspace}`);

  const want = (n) => !args.only || args.only.has(String(n));
  await mkdir(out, { recursive: true });
  const write = async (name, frames) => {
    const path = join(out, name);
    await writeFile(path, `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`);
    console.log(`\nwrote ${path}  (${frames.length} frames)`);
  };

  // ---- 1. Two FOREGROUND `agent` calls in ONE turn ------------------------
  if (want(1)) {
    const w1 = await openWatcher(gw);
    const conv1 = await newConversation(gw, agent.id, 'capture parallel');
    w1.subscribe(agent.id, conv1);
    const t1 = await w1.drive(
      agent.id,
      conv1,
      'In this ONE turn make TWO agent tool calls together, both general-purpose and ' +
        'both foreground: name the first "alpha" with the task "reply with exactly the ' +
        'word ALPHA and nothing else", and the second "beta" with the task "reply with ' +
        'exactly the word BETA and nothing else". Do not write any text between the two ' +
        'tool calls. Then answer with the two words separated by a space.',
    );
    const parallel = framesFor(w1.frames, [t1.id]);
    summarise(`foreground pair, turn ${t1.id}${t1.timedOut ? ' (TIMED OUT)' : ''}`, parallel);
    await write('subagent-parallel-frames.jsonl', parallel);
    w1.close();
  }

  // ---- 1b. Two BACKGROUND `agent` calls in ONE turn (D4's RED) ------------
  //
  // A background spawn's `agent` tool returns IMMEDIATELY ("launched in the
  // background"), so each child's own `tool_result` lands between the two
  // `subagent_started` anchors — while both children are still running, which
  // is unambiguously §8.2's parallel group.
  if (want('1b')) {
    const wb = await openWatcher(gw);
    const convb = await newConversation(gw, agent.id, 'capture background pair');
    wb.subscribe(agent.id, convb);
    const tb = await wb.drive(
      agent.id,
      convb,
      'In this ONE turn make TWO agent tool calls, both general-purpose and both with ' +
        'run_in_background true: name the first "alpha" with the task "reply with exactly ' +
        'the word ALPHA and nothing else", and the second "beta" with the task "reply with ' +
        'exactly the word BETA and nothing else". Do NOT wait for either. End your turn ' +
        'immediately after launching both.',
    );
    const pair = framesFor(wb.frames, [tb.id]);
    summarise(`background pair, turn ${tb.id}${tb.timedOut ? ' (TIMED OUT)' : ''}`, pair);
    await write('subagent-background-pair-frames.jsonl', pair);
    wb.close();
  }

  // ---- 1c. A foreground child that outlives one heartbeat (D5's frame) ----
  //
  // `subagent_progress` is TRANSIENT (spec §7.2): the hub broadcasts it with
  // no `seq` and never persists it. That is the frame MC and iOS reject.
  if (want('1c')) {
    const wp = await openWatcher(gw);
    const convp = await newConversation(gw, agent.id, 'capture progress');
    wp.subscribe(agent.id, convp);
    const tp = await wp.drive(
      agent.id,
      convp,
      'Use the agent tool ONCE, general-purpose, foreground (run_in_background false), ' +
        'name "sleeper", with the task: run the bash command `sleep 25` and then reply ' +
        'with exactly the word SLEPT and nothing else. Wait for it, then answer with one ' +
        'short sentence.',
    );
    const progress = framesFor(wp.frames, [tp.id]);
    summarise(`progress turn ${tp.id}${tp.timedOut ? ' (TIMED OUT)' : ''}`, progress);
    await write('subagent-progress-frames.jsonl', progress);
    wp.close();
  }

  // ---- 2. Background child + its notification turn (D2) -------------------
  if (want(2)) {
    const w2 = await openWatcher(gw);
    const conv2 = await newConversation(gw, agent.id, 'capture notification');
    w2.subscribe(agent.id, conv2);
    const before = new Set(w2.frames.filter((f) => f.type === 'accepted').map((f) => f.id));
    const t2 = await w2.drive(
      agent.id,
      conv2,
      'Use the agent tool with run_in_background true, subagent_type general-purpose and ' +
        'name "writer" to launch a child whose task is: reply with exactly the word ' +
        'WRITTEN and nothing else. Do NOT wait for it. End your turn immediately after ' +
        'launching it.',
    );
    const notif = await w2.waitFor(
      (fs) =>
        fs.find((f) => f.type === 'accepted' && f.origin === 'notification' && !before.has(f.id)),
      NOTIFY_MS,
    );
    if (notif) {
      await w2.waitFor(
        (fs) => fs.find((f) => f.id === notif.id && (f.type === 'done' || f.type === 'error')),
        NOTIFY_MS,
      );
    }
    const ids2 = notif ? [t2.id, notif.id] : [t2.id];
    const notification = framesFor(w2.frames, ids2);
    summarise(
      `notification stream ${ids2.join(' + ')}${notif ? '' : ' (NO NOTIFICATION TURN ARRIVED)'}`,
      notification,
    );
    await write('subagent-notification-frames.jsonl', notification);
    w2.close();
  }
} catch (err) {
  console.error(gw.tail(40));
  await gw.stop();
  envFail(String(err instanceof Error ? err.stack : err));
}
await gw.stop();
console.log('\ndone; throwaway root removed\n');

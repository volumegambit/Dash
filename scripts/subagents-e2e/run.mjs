// Sub-agents live E2E smoke (plan `2026-09-04-subagents-plan.md` §Task E1).
//
// WHAT IT BOOTS. A REAL gateway from THIS worktree under an isolated temp
// `DASH_HOME` (default `$TMPDIR/dash-subagents-e2e`, management 19332 / chat
// 19232), via `scripts/memory-e2e/harness.mjs`. Your own `~/.dash` is only
// READ — `secret.key` + `credentials.enc` are copied into the temp data dir
// and the whole tree is deleted on teardown. It also `git init`s a throwaway
// workspace inside that tree (gitignoring `docs/plans/`) and points the test
// agents at it, because `isolation: worktree` requires a git workspace and
// assertion 7 needs a gitignored deliverable to be possible.
//
// WHAT IT ASSERTS. The eight assertions of Task E1, in the order they are
// cheapest to debug — see `ASSERTIONS` below. This is the FIRST time any
// sub-agent behaviour on this branch runs against a real gateway, so it is a
// discovery pass, not a confirmation pass: it collects every WebSocket frame
// it sees, prints them, and asserts on both presence and (for the retired
// `worker_*` events) ABSENCE.
//
// WHAT IT COSTS. Real LLM calls — roughly a dozen turns across parents and
// children, a few cents at current prices. It is deliberately NOT part of
// `npm test` / `npm run preflight` / CI. Run it by hand after changing
// `packages/swarm/*`, `apps/gateway/src/subagent-*.ts`, the notification
// driver or the resumable chat hub.
//
// Run:    npm run subagents:e2e
//         npm run subagents:e2e -- --only 1,2,8      # a subset, to iterate
//         npm run subagents:e2e -- --model openrouter/anthropic/claude-sonnet-4.5
// Model:  `--model`, else $SUBAGENTS_E2E_MODEL, else $MEMORY_E2E_MODEL, else
//         the first model in ~/.dash/gateway/agents.json. The model that ran is
//         printed in the banner and in the summary.
// Prereq: Node >= 22.12 (the gateway needs it) and a provider API key
//         configured in ~/.dash/gateway.
//
// NOTE ON MODEL CHOICE: assertions 1-6 need a model that actually calls tools,
// and 5 needs one that will nest a delegation two levels deep. A model that
// ignores tools fails them, and that is a real result ABOUT THE MODEL, not a
// broken script — pin `--model` to tell the two apart.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  bootGateway,
  envFail,
  pickModel,
  preflight,
  registerAgent,
  sleep,
} from '../memory-e2e/harness.mjs';

const execFileAsync = promisify(execFile);

/** A parent turn's budget. Children run inside it, so it is generous. */
const TURN_MS = Number(process.env.SUBAGENTS_E2E_TURN_MS || 300_000);
/** How long to wait for a server-initiated notification turn after a `done`. */
const NOTIFY_MS = Number(process.env.SUBAGENTS_E2E_NOTIFY_MS || 180_000);

// --- Result bookkeeping ----------------------------------------------------

/** Every `event.type` seen on ANY socket this run — assertion 8 reads this. */
const seenEventTypes = new Set();
/** `{ n, title, status: 'pass'|'fail'|'skip', notes: string[], ms }` per assertion. */
const results = [];

let current = null;
const check = (ok, what, detail) => {
  console.log(`     ${ok ? '✅' : '❌'} ${what}`);
  if (detail !== undefined) console.log(`          ${String(detail).slice(0, 400)}`);
  current?.notes.push(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) current.ok = false;
  return ok;
};

// --- One WebSocket that watches a conversation -----------------------------

/**
 * A socket that keeps EVERY frame it is sent, keyed by nothing — the harness's
 * `driveTurn` drops frames whose `id` is not the turn it started, which is
 * exactly the frames a server-initiated notification turn arrives on. This
 * watcher subscribes to the conversation first, then drives turns on it, and
 * stays open across `done` so the notification lands in the same buffer.
 */
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
    if (m.type === 'event' && m.event?.type) seenEventTypes.add(m.event.type);
    for (const listener of [...listeners]) listener();
  };

  /** Resolve with the first truthy `pred(frames)`, or `undefined` on timeout. */
  const waitFor = (pred, timeoutMs) =>
    new Promise((resolve) => {
      // Declaration order is load-bearing: `probe` closes over `settle`, which
      // closes over `timer`, which closes over `probe`. Nothing is CALLED until
      // all three exist, so every binding can stay a const.
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
    send,
    subscribe(agentId, conversationId) {
      send({ type: 'subscribe', id: `sub-${rand()}`, agentId, conversationId });
    },
    /** Send one RESUMABLE turn and wait for its terminal frame. */
    async drive(agentId, conversationId, text, timeoutMs = TURN_MS) {
      const id = `req-${rand()}`;
      send({
        type: 'message',
        id,
        agentId,
        channelId: 'direct',
        conversationId,
        text,
        // Only a resumable turn runs through `resumable-chat-hub.ts`, and only
        // that hub delivers server-initiated notification turns to subscribers.
        resumable: true,
      });
      const end = await waitFor(
        (fs) => fs.find((f) => f.id === id && (f.type === 'done' || f.type === 'error')),
        timeoutMs,
      );
      if (end === undefined) diagnose(gw, frames, id, timeoutMs);
      return { id, end, timedOut: end === undefined, events: eventsOf(frames, id) };
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

/**
 * Everything a timed-out turn is allowed to be, printed so the next run does
 * not have to guess: whether the turn was ACCEPTED at all (no `accepted` means
 * the hub never took it — a protocol or routing problem), what else the socket
 * received meanwhile, and what the gateway itself said. A discovery smoke that
 * reports only "timed out" is not usable.
 */
function diagnose(gw, frames, id, timeoutMs) {
  const mine = frames.filter((f) => f.id === id);
  const others = frames.filter((f) => f.id !== id);
  console.log(`     ⏱  no terminal frame for ${id} within ${timeoutMs}ms`);
  console.log(
    `        frames for this turn (${mine.length}): ` +
      `${mine.map((f) => f.type).join(', ') || 'NONE — the hub never accepted it'}`,
  );
  console.log(
    `        frames on this socket for other ids (${others.length}): ` +
      `${[...new Set(others.map((f) => `${f.type}${f.origin ? `/${f.origin}` : ''}`))].join(', ') || 'none'}`,
  );
  console.log(`        --- gateway log tail ---\n${gw.tail(25)}`);
}

const rand = () => Math.random().toString(36).slice(2, 10);
const eventsOf = (frames, id) =>
  frames.filter((f) => f.type === 'event' && f.id === id).map((f) => f.event);
const replyOf = (frames, id) => {
  const events = eventsOf(frames, id);
  const responses = events.filter((e) => e.type === 'response');
  if (responses.length) return String(responses.at(-1).content ?? '');
  return events
    .filter((e) => e.type === 'text_delta')
    .map((e) => e.text ?? '')
    .join('');
};
const resultsOf = (events, name) =>
  events.filter((e) => e.type === 'tool_result' && e.name === name);
const oneLine = (s, n = 200) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, n);

/** Trace a turn's tools and sub-agent events, so a failure is debuggable. */
function trace(events, indent = '     ') {
  for (const e of events) {
    if (e.type === 'tool_use_start') {
      console.log(`${indent}→ CALL   ${e.name}  ${oneLine(JSON.stringify(e.input || {}), 160)}`);
    } else if (e.type === 'tool_result') {
      console.log(
        `${indent}← RESULT ${e.name}${e.isError ? ' (ERROR)' : ''}  ${oneLine(e.content)}`,
      );
    } else if (e.type === 'subagent_started') {
      console.log(
        `${indent}★ START  ${e.subagentId} type=${e.subagentType} depth=${e.depth} ` +
          `bg=${e.background}${e.name ? ` name=${e.name}` : ''}` +
          `${e.isolation ? ` isolation=${e.isolation}` : ''}`,
      );
    } else if (e.type === 'subagent_finished') {
      console.log(
        `${indent}★ FINISH ${e.subagentId} status=${e.status} tools=${e.toolCallCount} ` +
          `report="${oneLine(e.report, 120)}"`,
      );
    }
  }
}

// --- Management-API helpers ------------------------------------------------

async function api(gw, path, init) {
  const res = await fetch(`${gw.mgmtUrl}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

async function newConversation(gw, agentId, title) {
  const res = await api(gw, '/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId, requestId: `subagents-e2e-${rand()}`, title }),
  });
  if (!res.ok) throw new Error(`conversation create failed: ${res.status} ${oneLine(res.body)}`);
  return res.body.id;
}

/** The persisted text of one message, by id — how a notification prompt is read. */
async function messageText(gw, conversationId, messageId) {
  const res = await api(gw, `/conversations/${conversationId}/messages?limit=200`);
  const item = res.ok ? res.body.items?.find((m) => m.id === messageId) : undefined;
  return item?.content?.text ?? '';
}

// --- The throwaway git workspace -------------------------------------------

/**
 * A real git repo the agents work in. `isolation: worktree` refuses a non-git
 * workspace, and assertion 7's second half needs a path this repo GITIGNORES —
 * the B6 Critical is that an ignored deliverable must still keep the worktree.
 */
async function makeWorkspace(root) {
  const dir = join(root, 'workspace');
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, '.gitignore'), 'docs/plans/\nnode_modules/\n');
  await writeFile(join(dir, 'README.md'), '# subagents e2e workspace\n');
  await writeFile(join(dir, 'alpha.txt'), 'alpha\n');
  await writeFile(join(dir, 'beta.txt'), 'beta\n');
  const git = (...args) => execFileAsync('git', ['-C', dir, ...args]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'e2e@example.invalid');
  await git('config', 'user.name', 'subagents e2e');
  await git('add', '-A');
  await git('commit', '-qm', 'workspace fixture');
  return dir;
}

// --- Assertions ------------------------------------------------------------

/**
 * 1. Foreground: one blocking `agent` call.
 *
 * First live drive of A1-A8 — the tool, the spawn seam, the child runtime, and
 * the `subagent_started` / `subagent_finished` pair on the parent stream.
 */
async function assertion1(ctx) {
  const w = await openWatcher(ctx.gw);
  try {
    const conv = await newConversation(ctx.gw, ctx.agent.id, 'e1 foreground');
    w.subscribe(ctx.agent.id, conv);
    const turn = await w.drive(
      ctx.agent.id,
      conv,
      'Use the agent tool with subagent_type Explore to list the files in the ' +
        'workspace and report the count. Wait for its report, then tell me the count.',
    );
    trace(turn.events);
    if (!check(!turn.timedOut, 'the parent turn finished', turn.end?.type)) return;
    const started = turn.events.filter((e) => e.type === 'subagent_started');
    const finished = turn.events.filter((e) => e.type === 'subagent_finished');
    check(started.length >= 1, 'parent stream carries subagent_started', `${started.length} seen`);
    check(
      finished.length >= 1 && finished[0].status === 'done',
      "parent stream carries subagent_finished { status: 'done' }",
      finished.map((f) => f.status).join(',') || 'none',
    );
    check(
      started[0]?.background === false && started[0]?.depth === 1,
      'the child is foreground at depth 1',
      `background=${started[0]?.background} depth=${started[0]?.depth}`,
    );
    const result = resultsOf(turn.events, 'agent')[0];
    check(result !== undefined, 'the agent tool produced a result', undefined);
    check(
      result !== undefined &&
        finished[0] !== undefined &&
        result.content.trim() === finished[0].report.trim(),
      "the tool result text equals the child's report",
      result && finished[0]
        ? `result="${oneLine(result.content, 90)}" report="${oneLine(finished[0].report, 90)}"`
        : 'missing',
    );
    ctx.log.push(`1: child ${started[0]?.subagentId} ${finished[0]?.status}`);
  } finally {
    w.close();
  }
}

/** 2. Parallel: two children start before either finishes. */
async function assertion2(ctx) {
  const w = await openWatcher(ctx.gw);
  try {
    const conv = await newConversation(ctx.gw, ctx.agent.id, 'e1 parallel');
    w.subscribe(ctx.agent.id, conv);
    const turn = await w.drive(
      ctx.agent.id,
      conv,
      'In this one turn, make TWO agent tool calls together: one Explore agent ' +
        'that lists the files in the workspace, and one Explore agent that counts ' +
        'the lines in alpha.txt and beta.txt. Then reconcile their two reports in ' +
        'your answer.',
    );
    trace(turn.events);
    if (!check(!turn.timedOut, 'the parent turn finished', turn.end?.type)) return;
    const order = turn.events
      .filter((e) => e.type === 'subagent_started' || e.type === 'subagent_finished')
      .map((e) => e.type);
    const firstFinish = order.indexOf('subagent_finished');
    const startsBeforeFirstFinish =
      firstFinish === -1 ? order.length : order.slice(0, firstFinish).length;
    check(
      order.filter((t) => t === 'subagent_started').length >= 2,
      'two children were started in one turn',
      order.join(' → ') || 'none',
    );
    check(
      startsBeforeFirstFinish >= 2,
      'both subagent_started arrive BEFORE any subagent_finished (concurrency default)',
      `${startsBeforeFirstFinish} start(s) precede the first finish`,
    );
  } finally {
    w.close();
  }
}

/**
 * 3. Background + notification.
 *
 * First live drive of C3/C7's notification turn: the child is detached, the
 * parent's turn ends without it, and the coordinator wakes the conversation
 * with a server-initiated turn that only a SUBSCRIBER sees.
 */
async function assertion3(ctx) {
  const w = ctx.writerWatcher;
  const conv = ctx.writerConv;
  const before = new Set(w.frames.filter((f) => f.type === 'accepted').map((f) => f.id));
  const turn = await w.drive(
    ctx.agent.id,
    conv,
    'Use the agent tool with run_in_background true and name "writer" to launch a ' +
      'general-purpose agent whose task is: write the single line "hello from the ' +
      'writer" into a file called hello.txt in the workspace, then report the ' +
      'absolute path you wrote. Do NOT wait for it. End your turn immediately ' +
      'after launching it.',
  );
  trace(turn.events);
  if (!check(!turn.timedOut, 'the parent turn finished', turn.end?.type)) return;
  const started = turn.events.filter((e) => e.type === 'subagent_started');
  check(
    started.length === 1 && started[0].background === true,
    'a BACKGROUND child was started',
    started.map((s) => `${s.subagentId} bg=${s.background} name=${s.name}`).join(', ') || 'none',
  );
  ctx.writerId = started[0]?.subagentId;

  const accepted = await w.waitFor(
    (fs) =>
      fs.find((f) => f.type === 'accepted' && f.origin === 'notification' && !before.has(f.id)),
    NOTIFY_MS,
  );
  if (
    !check(
      accepted !== undefined,
      "a second accepted { origin: 'notification' } arrived on the subscribed socket",
      accepted ? `id=${accepted.id} kind=${accepted.kind}` : `nothing within ${NOTIFY_MS}ms`,
    )
  ) {
    return;
  }
  const end = await w.waitFor(
    (fs) => fs.find((f) => f.id === accepted.id && (f.type === 'done' || f.type === 'error')),
    NOTIFY_MS,
  );
  const notifEvents = eventsOf(w.frames, accepted.id);
  trace(notifEvents);
  const prompt = await messageText(ctx.gw, conv, accepted.userMessageId);
  check(
    prompt.includes('<task-notification>'),
    'the notification user message contains <task-notification>',
    oneLine(prompt, 240),
  );
  check(
    notifEvents.some((e) => e.type === 'subagent_finished' && e.status === 'done'),
    "the notification turn replays subagent_finished { status: 'done' }",
    notifEvents
      .filter((e) => e.type === 'subagent_finished')
      .map((e) => e.status)
      .join(',') || 'none',
  );
  const reply = replyOf(w.frames, accepted.id);
  check(!!end && end.type === 'done', 'the notification turn completed', end?.type);
  check(/hello\.txt/i.test(reply), "the parent's reply mentions the file", oneLine(reply, 240));
  ctx.log.push(`3: writer=${ctx.writerId} notificationTurn=${accepted.id}`);
}

/**
 * 4. Resume.
 *
 * Two paths, and they are NOT the same path:
 *  (a) the `send_message` TOOL — the orchestrator resumes its own child. It
 *      carries no correlation id (`agent-tool.ts` calls `sendToChild` with two
 *      arguments), so there is nothing to echo on the resumed turn.
 *  (b) `POST /subagents/:id/resume { message, requestId }` — a CLIENT resumes
 *      the child. That is the only producer of `StartSystemTurnInput.requestId`,
 *      so this is where `accepted.requestId` can be asserted, and it lands on
 *      the CHILD conversation, not the parent's.
 */
async function assertion4(ctx) {
  const w = ctx.writerWatcher;
  const conv = ctx.writerConv;
  if (!check(!!ctx.writerId, 'assertion 3 left a resumable child', ctx.writerId ?? 'none')) return;

  const before = new Set(w.frames.filter((f) => f.type === 'accepted').map((f) => f.id));
  const turn = await w.drive(
    ctx.agent.id,
    conv,
    'Use send_message to tell writer to append a second line "and a second line" ' +
      'to hello.txt and report the file contents. Then end your turn.',
  );
  trace(turn.events);
  const sent = resultsOf(turn.events, 'send_message');
  check(
    sent.length >= 1 && !sent[0].isError,
    'the send_message tool resumed the child',
    sent.map((s) => oneLine(s.content, 80)).join(' | ') || 'no send_message call',
  );
  const accepted = await w.waitFor(
    (fs) =>
      fs.find((f) => f.type === 'accepted' && f.origin === 'notification' && !before.has(f.id)),
    NOTIFY_MS,
  );
  check(
    accepted !== undefined,
    'the resumed turn produced ANOTHER notification on the parent',
    accepted ? `id=${accepted.id}` : `nothing within ${NOTIFY_MS}ms`,
  );
  if (accepted) {
    await w.waitFor(
      (fs) => fs.find((f) => f.id === accepted.id && (f.type === 'done' || f.type === 'error')),
      NOTIFY_MS,
    );
    trace(eventsOf(w.frames, accepted.id));
  }

  // (b) The HTTP resume, watched on the CHILD conversation.
  const child = await openWatcher(ctx.gw);
  try {
    child.subscribe(ctx.agent.id, ctx.writerId);
    await sleep(200);
    const requestId = `e1-resume-${rand()}`;
    const res = await api(ctx.gw, `/subagents/${ctx.writerId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Reply with exactly: ACK', requestId }),
    });
    if (!check(res.ok, 'POST /subagents/:id/resume accepted the request', `${res.status}`)) return;
    const accepted2 = await child.waitFor(
      (fs) => fs.find((f) => f.type === 'accepted' && f.requestId === requestId),
      NOTIFY_MS,
    );
    check(
      accepted2 !== undefined,
      'the resumed turn echoes accepted.requestId on the child conversation',
      accepted2 ? `requestId=${accepted2.requestId} origin=${accepted2.origin}` : 'no echo',
    );
    await child.waitFor(
      (fs) => fs.find((f) => f.id === accepted2?.id && (f.type === 'done' || f.type === 'error')),
      NOTIFY_MS,
    );
  } finally {
    child.close();
  }
}

/**
 * 5. Nesting.
 *
 * `subagents.maxDepth: 2` — the registration validator accepts the key
 * (`management-api.ts` `validateAgentSubagents`), so a depth-2 child is
 * reachable. The depth-2 child's own transcript is read back from the event
 * log rather than watched live, because it is a different conversation and the
 * race to subscribe to it is unwinnable.
 *
 * The plan's second clause ("the depth-2 child's attempt to spawn fails with
 * `depth limit reached` in its tool result") is NOT reachable at maxDepth 2 —
 * see the report. A depth-2 child is never handed the `agent` tool at all
 * (`subagent-tools.ts` `createChildSpawnTools` returns `[]` when
 * `depth >= maxDepth`, and `resolve-spawn.ts` sets `canSpawn` false when
 * `parent.depth + 1 >= parent.maxDepth`). The coordinator's own
 * `depth limit reached` refusal is only reachable where the tool IS granted
 * and the ceiling is already hit — a top-level orchestrator at maxDepth 0 —
 * so that is driven here as 5b against a second agent.
 */
async function assertion5(ctx) {
  const w = await openWatcher(ctx.gw);
  try {
    const conv = await newConversation(ctx.gw, ctx.nested.id, 'e1 nesting');
    w.subscribe(ctx.nested.id, conv);
    const turn = await w.drive(
      ctx.nested.id,
      conv,
      'Use the agent tool ONCE to launch a general-purpose agent. Its prompt must ' +
        'be exactly: "You have an agent tool of your own. Use it to launch an ' +
        'Explore agent that lists the files in the workspace, wait for that ' +
        'agent\'s report, then report the file list back to me." Wait for your ' +
        "agent's report and relay it.",
    );
    trace(turn.events);
    const depth1 = turn.events.find((e) => e.type === 'subagent_started');
    if (!check(depth1 !== undefined, 'a depth-1 child was started', depth1?.subagentId)) return;
    check(depth1.depth === 1, 'the direct child is depth 1', `depth=${depth1.depth}`);

    const replay = await api(
      ctx.gw,
      `/agents/${ctx.nested.id}/conversations/${depth1.subagentId}/events`,
    );
    const childEvents = (replay.ok ? (replay.body.entries ?? []) : [])
      .filter((e) => e.payload?.type === 'event')
      .map((e) => e.payload.event);
    for (const e of childEvents) if (e?.type) seenEventTypes.add(e.type);
    trace(childEvents, '       ');
    const depth2 = childEvents.find((e) => e.type === 'subagent_started');
    check(
      depth2 !== undefined && depth2.depth === 2,
      "a depth-2 subagent_started appears in the child's own transcript",
      depth2 ? `id=${depth2.subagentId} depth=${depth2.depth}` : 'none',
    );
    const roster = await api(ctx.gw, `/conversations/${depth1.subagentId}/subagents`);
    check(
      roster.ok && roster.body.subagents?.some((s) => s.depth === 2),
      'GET /conversations/:childId/subagents lists the grandchild at depth 2',
      oneLine(JSON.stringify(roster.body?.subagents ?? roster.body)),
    );
    if (depth2) {
      const gcReplay = await api(
        ctx.gw,
        `/agents/${ctx.nested.id}/conversations/${depth2.subagentId}/events`,
      );
      const gcEvents = (gcReplay.ok ? (gcReplay.body.entries ?? []) : [])
        .filter((e) => e.payload?.type === 'event')
        .map((e) => e.payload.event);
      for (const e of gcEvents) if (e?.type) seenEventTypes.add(e.type);
      check(
        gcEvents.length > 0 &&
          !gcEvents.some((e) => e.type === 'tool_use_start' && e.name === 'agent'),
        'the depth-2 child was never handed an `agent` tool (the ceiling is a GRANT, not an error; ' +
          'an EMPTY replay is a failure, not a pass)',
        gcEvents
          .filter((e) => e.type === 'tool_use_start')
          .map((e) => e.name)
          .join(',') || 'no tool calls',
      );
    }
  } finally {
    w.close();
  }

  // 5b: the coordinator's own refusal, where it is actually reachable.
  const w2 = await openWatcher(ctx.gw);
  try {
    const conv = await newConversation(ctx.gw, ctx.noNest.id, 'e1 depth ceiling');
    w2.subscribe(ctx.noNest.id, conv);
    const turn = await w2.drive(
      ctx.noNest.id,
      conv,
      'Use the agent tool with subagent_type Explore to list the files in the ' +
        'workspace. If the tool returns an error, quote the error text verbatim.',
    );
    trace(turn.events);
    const errors = resultsOf(turn.events, 'agent').filter((r) => r.isError);
    check(
      errors.some((r) => /depth limit reached/.test(r.content)),
      'an orchestrator at maxDepth 0 gets `depth limit reached` in the tool RESULT',
      errors.map((r) => oneLine(r.content, 140)).join(' | ') || 'no error result',
    );
  } finally {
    w2.close();
  }
}

/**
 * 6. Cancel.
 *
 * First live drive of C3/C6's cancel cascade. A background child on a long
 * `bash sleep`, stopped over HTTP; the terminal transition enqueues a
 * notification for ANY status (`coordinator.onChildTerminal`), so the cancel
 * must come back as a notification turn, not merely as a row update.
 */
async function assertion6(ctx) {
  const w = await openWatcher(ctx.gw);
  try {
    const conv = await newConversation(ctx.gw, ctx.agent.id, 'e1 cancel');
    w.subscribe(ctx.agent.id, conv);
    const before = new Set(w.frames.filter((f) => f.type === 'accepted').map((f) => f.id));
    const turn = await w.drive(
      ctx.agent.id,
      conv,
      'Use the agent tool with run_in_background true and name "sleeper" to launch ' +
        'a general-purpose agent whose task is exactly: "Run the bash command ' +
        '`sleep 30` and then report done." Do NOT wait for it. End your turn ' +
        'immediately after launching it.',
    );
    trace(turn.events);
    const started = turn.events.find((e) => e.type === 'subagent_started');
    if (!check(started !== undefined, 'the background child was started', started?.subagentId)) {
      return;
    }
    // Give it a moment to actually be inside `sleep 30`.
    await sleep(3000);
    const stop = await api(ctx.gw, `/subagents/${started.subagentId}/stop`, { method: 'POST' });
    check(
      stop.ok && stop.body?.ok === true,
      'POST /subagents/:id/stop succeeded',
      `${stop.status} ${oneLine(JSON.stringify(stop.body))}`,
    );
    const accepted = await w.waitFor(
      (fs) =>
        fs.find((f) => f.type === 'accepted' && f.origin === 'notification' && !before.has(f.id)),
      NOTIFY_MS,
    );
    if (
      !check(
        accepted !== undefined,
        'the cancel produced a notification turn on the parent',
        accepted ? `id=${accepted.id}` : `nothing within ${NOTIFY_MS}ms`,
      )
    ) {
      return;
    }
    await w.waitFor(
      (fs) => fs.find((f) => f.id === accepted.id && (f.type === 'done' || f.type === 'error')),
      NOTIFY_MS,
    );
    const notifEvents = eventsOf(w.frames, accepted.id);
    trace(notifEvents);
    check(
      notifEvents.some((e) => e.type === 'subagent_finished' && e.status === 'cancelled'),
      "the notification carries subagent_finished { status: 'cancelled' }",
      notifEvents
        .filter((e) => e.type === 'subagent_finished')
        .map((e) => e.status)
        .join(',') || 'none',
    );
    const prompt = await messageText(ctx.gw, conv, accepted.userMessageId);
    check(
      prompt.includes('<status>cancelled</status>'),
      'the notification prompt reports the cancelled status',
      oneLine(prompt, 240),
    );
  } finally {
    w.close();
  }
}

/**
 * 7. Worktree isolation, both halves.
 *
 *  a. a child that changes nothing → its worktree is REMOVED after it finishes.
 *  b. a child that writes ONLY into `docs/plans/` (gitignored in the fixture
 *     workspace) → its worktree is KEPT. That was B6's Critical: without
 *     `--ignored=matching` the tree reads clean and the removal silently
 *     destroys the deliverable.
 */
async function assertion7(ctx) {
  const worktreeOf = (childId) => join(ctx.gw.dataDir, 'worktrees', ctx.agent.name, childId);

  const w = await openWatcher(ctx.gw);
  try {
    const conv = await newConversation(ctx.gw, ctx.agent.id, 'e1 worktree clean');
    w.subscribe(ctx.agent.id, conv);
    const turn = await w.drive(
      ctx.agent.id,
      conv,
      'Use the agent tool with isolation "worktree" and subagent_type Explore to ' +
        'list the files in the workspace and report them. Do not ask it to change ' +
        'anything. Relay its report.',
    );
    trace(turn.events);
    const started = turn.events.find((e) => e.type === 'subagent_started');
    if (!check(started !== undefined, '7a: an isolated child was started', started?.subagentId)) {
      return;
    }
    check(
      started.isolation === 'worktree',
      '7a: subagent_started carries isolation=worktree',
      started.isolation,
    );
    // Cleanup runs on the terminal transition, which can trail the tool result.
    for (let i = 0; i < 20 && existsSync(worktreeOf(started.subagentId)); i++) await sleep(500);
    check(
      !existsSync(worktreeOf(started.subagentId)),
      "7a: a clean child's worktree is removed after it finishes",
      worktreeOf(started.subagentId),
    );
  } finally {
    w.close();
  }

  const w2 = await openWatcher(ctx.gw);
  try {
    const conv = await newConversation(ctx.gw, ctx.agent.id, 'e1 worktree dirty');
    w2.subscribe(ctx.agent.id, conv);
    const turn = await w2.drive(
      ctx.agent.id,
      conv,
      'Use the agent tool with isolation "worktree" to launch a general-purpose ' +
        'agent whose task is exactly: "Create the directory docs/plans if it does ' +
        'not exist and write a file docs/plans/e1-note.md containing the single ' +
        'line `e1 was here`. Write NOTHING else, create no other files, and do ' +
        'not commit. Then report the path you wrote." Relay its report.',
    );
    trace(turn.events);
    const started = turn.events.find((e) => e.type === 'subagent_started');
    if (!check(started !== undefined, '7b: an isolated child was started', started?.subagentId)) {
      return;
    }
    const path = worktreeOf(started.subagentId);
    await sleep(4000);
    check(
      existsSync(path),
      '7b: a worktree holding only a GITIGNORED deliverable is KEPT (B6 Critical)',
      path,
    );
    check(
      existsSync(join(path, 'docs/plans/e1-note.md')),
      '7b: the gitignored deliverable survived',
      join(path, 'docs/plans/e1-note.md'),
    );
    const kept = ctx.gw.log.join('').includes(`keeping ${path}`);
    check(kept, '7b: the gateway warned about the kept worktree path', kept ? path : 'no warning');
  } finally {
    w2.close();
  }
}

/**
 * 8. The legacy swarm facades.
 *
 * D8 retired the `worker_*` mirror events (`be9945f3`) and rebuilt the four
 * legacy tools as §5.2 facades over the same spawn seam `agent` uses
 * (`0bf4c6c1`). So this asserts on the tools' RESULTS — never on `worker_*`
 * frames — plus two structural facts: the legacy spawn is adopted into the
 * shared `SwarmRun` path and therefore emits `subagent_started`, and NO
 * `worker_*` frame appears anywhere on any socket for the whole run.
 */
async function assertion8(ctx) {
  const w = await openWatcher(ctx.gw);
  try {
    const conv = await newConversation(ctx.gw, ctx.agent.id, 'e1 legacy');
    w.subscribe(ctx.agent.id, conv);
    const turn = await w.drive(
      ctx.agent.id,
      conv,
      'Use the legacy swarm tools, in this order and nothing else: (1) spawn_worker ' +
        'with role "counter" and a brief asking it to count the files in the ' +
        'workspace and report the number; (2) wait_workers to collect it; ' +
        '(3) check_workers to snapshot the roster. Then tell me the number and ' +
        'paste the check_workers output.',
    );
    trace(turn.events);
    const spawn = resultsOf(turn.events, 'spawn_worker')[0];
    const spawnedId = spawn?.content.match(/spawned (sub_[0-9A-Za-z]{26})/)?.[1];
    const wait = resultsOf(turn.events, 'wait_workers')[0];
    const roster = resultsOf(turn.events, 'check_workers')[0];
    check(
      spawn !== undefined && !spawn.isError && /^spawned sub_/.test(spawn.content.trim()),
      'spawn_worker returns `spawned <subagentId> (<role>)`',
      spawn ? oneLine(spawn.content, 120) : 'not called',
    );
    check(
      wait !== undefined && !wait.isError && /:\s*(done|failed|max_turns)/.test(wait.content),
      'wait_workers returns the collected worker with a terminal status',
      wait ? oneLine(wait.content, 200) : 'not called',
    );
    check(
      roster !== undefined &&
        !roster.isError &&
        spawnedId !== undefined &&
        roster.content.includes(spawnedId),
      'check_workers returns the roster the facade built (names the id spawn_worker returned)',
      roster ? oneLine(roster.content, 200) : 'not called',
    );
    const started = turn.events.filter((e) => e.type === 'subagent_started');
    check(
      started.length >= 1,
      'the LEGACY spawn produces a subagent_started on the parent stream (shared SwarmRun path)',
      started.map((s) => `${s.subagentId} bg=${s.background} name=${s.name}`).join(', ') || 'none',
    );
  } finally {
    w.close();
  }
}

/**
 * 9. A parked ONE-SHOT child, answered with the `send_message` TOOL.
 *
 * `coordinator.startChild` hands `ask_orchestrator` to EVERY child, the
 * one-shot built-ins `Explore` and `Plan` included, so a one-shot child can
 * park itself in `waiting_input`. `sendToChild` exempts an ANSWER from its
 * one-shot refusal; the `send_message` tool used to throw its own refusal
 * FIRST, so the orchestrator could not answer a question its own child had
 * asked — while the legacy `send_to_worker` facade, which calls `sendToChild`
 * directly, could.
 *
 * ONE TURN, and that is the whole shape of the case. A parked child's question
 * is bounded by the parent's turn: `SwarmRun.finalize` fires `closed` for
 * in-flight tool settlement (`run.ts:307`), which aborts a pending
 * `ask_orchestrator` with `ask_orchestrator aborted` — measured here before
 * this assertion was written. So a background child cannot still be parked in
 * a LATER turn, and a foreground `agent` call never returns while its child is
 * parked (`returnOnWaitingInput: false`). The parent must therefore answer
 * inside the same turn, which is exactly what the legacy
 * `spawn_worker` → `wait_workers` → `send_to_worker` loop does.
 *
 * Three observations, none of which can pass on absence: the child really
 * parks (polled from REST while the turn is still open, because
 * `subagent_progress` is transient), the tool call really is not a refusal,
 * and the child really reaches a terminal status afterwards.
 */
async function assertion9(ctx) {
  const w = await openWatcher(ctx.gw);
  try {
    const conv = await newConversation(ctx.gw, ctx.agent.id, 'e1 parked one-shot');
    w.subscribe(ctx.agent.id, conv);
    const childPrompt = [
      'There are two files in the workspace, alpha.txt and beta.txt. Only the',
      'orchestrator knows which one matters, and the answer is NOT in the',
      'workspace, so you cannot work it out by reading anything. Your FIRST',
      'action must be to call the ask_orchestrator tool with the question:',
      'which file should I read, alpha.txt or beta.txt? Do not guess and do not',
      'read any file until you have the answer. Then read exactly the file the',
      'answer names and report its contents.',
    ].join(' ');
    const prompt = [
      'Do ALL of the following in this one turn, in order, and do not end your',
      'turn until every step is done. (1) Use the agent tool with subagent_type',
      '"Explore", run_in_background true and name "asker", passing EXACTLY this',
      `text as its prompt: "${childPrompt}" (2) Then run this bash command and`,
      'wait for it: sleep 25 (3) Then use send_message to send "asker" exactly',
      'this message: alpha.txt (4) Then tell me, in one sentence, what',
      'send_message returned.',
    ].join(' ');

    // The drive runs while we poll: the child is only parked WHILE this turn is
    // open, so a check after the turn would always be too late.
    const driving = w.drive(ctx.agent.id, conv, prompt);
    let parked;
    const deadline = Date.now() + NOTIFY_MS;
    let settled = false;
    void driving.then(() => {
      settled = true;
    });
    while (Date.now() < deadline && !settled && !parked) {
      const roster = await api(ctx.gw, `/conversations/${conv}/subagents`);
      parked = roster.ok
        ? roster.body.subagents?.find((s) => s.status === 'waiting_input')
        : undefined;
      if (parked) break;
      await sleep(400);
    }
    const turn = await driving;
    trace(turn.events);

    const started = turn.events.filter((e) => e.type === 'subagent_started');
    const child = started[0];
    check(
      child !== undefined && child.background === true && child.subagentType === 'Explore',
      '9: a BACKGROUND one-shot Explore child was started',
      started.map((s) => `${s.subagentId} type=${s.subagentType} bg=${s.background}`).join(', ') ||
        'none',
    );
    check(
      parked !== undefined && parked.oneShot === true,
      '9: the ONE-SHOT child parked itself in waiting_input on an ask_orchestrator question',
      parked ? `id=${parked.id} status=${parked.status} oneShot=${parked.oneShot}` : 'never parked',
    );

    const sent = resultsOf(turn.events, 'send_message');
    check(
      sent.length >= 1 && !sent[0].isError && !/one-shot/i.test(sent[0].content),
      '9: send_message ANSWERED the parked one-shot child — no one-shot refusal',
      sent.map((r) => `${r.isError ? 'ERROR ' : ''}${oneLine(r.content, 120)}`).join(' | ') ||
        'no send_message call',
    );

    // The ANSWER has to have reached the child's own tool call. Leaving
    // `waiting_input` is not enough on its own: the parent's turn ending fires
    // the run's `closed`, which aborts a pending ask with
    // `ask_orchestrator aborted` and also leaves the child running.
    const childId = child?.subagentId ?? parked?.id;
    let askResult;
    const askBy = Date.now() + 20_000;
    while (Date.now() < askBy) {
      const replay = await api(ctx.gw, `/agents/${ctx.agent.id}/conversations/${childId}/events`);
      const events = (replay.ok ? (replay.body.entries ?? []) : [])
        .filter((e) => e.payload?.type === 'event')
        .map((e) => e.payload.event);
      askResult = events.find(
        (e) => e?.type === 'tool_result' && /alpha|abort/i.test(String(e.content ?? '')),
      );
      if (askResult) break;
      await sleep(500);
    }
    check(
      askResult !== undefined &&
        askResult.isError !== true &&
        /alpha/i.test(String(askResult.content ?? '')),
      "9: the answer reached the child's own ask_orchestrator call (not an abort)",
      askResult
        ? `isError=${askResult.isError === true} ${oneLine(String(askResult.content ?? ''), 80)}`
        : 'no ask_orchestrator result in the child transcript',
    );
    if (!sent.length || sent[0]?.isError || !parked) {
      const replay = await api(
        ctx.gw,
        `/agents/${ctx.agent.id}/conversations/${child?.subagentId}/events`,
      );
      const childEvents = (replay.ok ? (replay.body.entries ?? []) : [])
        .filter((e) => e.payload?.type === 'event')
        .map((e) => e.payload.event);
      console.log(
        `       child tool calls: ${
          childEvents
            .filter((e) => e?.type === 'tool_use_start')
            .map((e) => e.name)
            .join(', ') || 'none'
        }`,
      );
      for (const e of childEvents.filter((e) => e?.type === 'tool_result')) {
        console.log(
          `       child tool_result isError=${e.isError === true}: ${oneLine(
            typeof e.content === 'string' ? e.content : JSON.stringify(e.content),
            200,
          )}`,
        );
      }
    }
  } finally {
    w.close();
  }
}

/** The positive-absence check, run last so it sees every frame of the run. */
function assertionWorkerAbsence() {
  const types = [...seenEventTypes].sort();
  const retired = types.filter((t) => t.startsWith('worker_'));
  console.log(`     event types seen this run (${types.length}): ${types.join(', ')}`);
  check(
    retired.length === 0,
    'NO worker_* frame appeared anywhere on the socket for the whole run',
    retired.length ? `retired events still emitted: ${retired.join(', ')}` : 'none',
  );
}

const ASSERTIONS = [
  [1, 'Foreground agent call', assertion1],
  [2, 'Parallel children', assertion2],
  [8, 'Legacy swarm facades', assertion8],
  [3, 'Background child + notification turn', assertion3],
  [4, 'Resume (send_message tool + HTTP resume)', assertion4],
  [7, 'Worktree isolation (clean removed / ignored kept)', assertion7],
  [6, 'Cancel cascade', assertion6],
  [5, 'Nesting + the depth ceiling', assertion5],
  [9, 'Parked one-shot answered with the send_message TOOL', assertion9],
];

// --- Main ------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--model' || arg === '--only' || arg === '--skip') out[arg.slice(2)] = argv[++i];
    else if (arg.startsWith('--model=')) out.model = arg.slice(8);
    else if (arg.startsWith('--only=')) out.only = arg.slice(7);
    else if (arg.startsWith('--skip=')) out.skip = arg.slice(7);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
await preflight();
const model = args.model || process.env.SUBAGENTS_E2E_MODEL || (await pickModel());
const only = args.only ? new Set(args.only.split(',').map((n) => Number(n.trim()))) : undefined;
const skip = args.skip ? new Set(args.skip.split(',').map((n) => Number(n.trim()))) : new Set();
if (only?.has(Number.NaN) || [...skip].includes(Number.NaN)) {
  envFail('--only / --skip take a comma-separated list of assertion numbers, e.g. --only 1,2,8');
}

console.log(`\n========== subagents:e2e  model=${model} ==========\n`);

const root = join(process.env.TMPDIR || '/tmp', 'dash-subagents-e2e');
const gw = await bootGateway({
  root,
  mgmtPort: Number(process.env.SUBAGENTS_E2E_MPORT || 19332),
  chatPort: Number(process.env.SUBAGENTS_E2E_CPORT || 19232),
});

const started = Date.now();
try {
  const workspace = await makeWorkspace(root);
  console.log(`workspace ${workspace} (git, docs/plans/ ignored)`);

  const base = {
    model,
    workspace,
    systemPrompt:
      'You are a terse test orchestrator. Do exactly what you are asked with the ' +
      'tools you are given, then answer in one or two short sentences.',
  };
  const agent = await registerAgent(gw, {
    ...base,
    name: 'subagents-e2e',
    // `delegation: auto` pinned rather than derived from the model tier, so a
    // non-frontier model still gets the proactive delegation prompt and the
    // smoke measures the wiring instead of the catalog.
    subagents: { delegation: 'auto', maxConcurrent: 4, maxPerTurn: 6 },
  });
  const nested = await registerAgent(gw, {
    ...base,
    name: 'subagents-e2e-nested',
    subagents: { delegation: 'auto', maxDepth: 2 },
  });
  const noNest = await registerAgent(gw, {
    ...base,
    name: 'subagents-e2e-flat',
    subagents: { delegation: 'auto', maxDepth: 0 },
  });
  console.log(`agents ${agent.id} (default) ${nested.id} (maxDepth 2) ${noNest.id} (maxDepth 0)`);
  // The registration validator accepting `subagents.maxDepth` is a precondition
  // of assertion 5; a 400 here would be the finding, not a model failure.
  //
  // NOTE: the harness's `setMemoryConfig` is deliberately NOT called. Agent
  // memory does not exist on this branch — `PATCH /agents/:id/memory/config`
  // is a 404 here — so there is no post-turn sweep to pin off, unlike
  // `skills:e2e` on main.

  // Assertions 3 and 4 share one conversation and one socket: `writer` must
  // still be in the parent's roster when 4 resumes it.
  const writerWatcher = await openWatcher(gw);
  const writerConv = await newConversation(gw, agent.id, 'e1 background + resume');
  writerWatcher.subscribe(agent.id, writerConv);

  const ctx = { gw, agent, nested, noNest, workspace, writerWatcher, writerConv, log: [] };

  try {
    for (const [n, title, fn] of ASSERTIONS) {
      if ((only && !only.has(n)) || skip.has(n)) {
        results.push({ n, title, status: 'skip', notes: [], ms: 0 });
        continue;
      }
      console.log(`\n--- ${n}. ${title} ---`);
      const t0 = Date.now();
      current = { ok: true, notes: [] };
      try {
        await fn(ctx);
      } catch (err) {
        current.ok = false;
        current.notes.push(`THREW ${err instanceof Error ? err.message : String(err)}`);
        console.log(`     ❌ threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      results.push({
        n,
        title,
        status: current.ok ? 'pass' : 'fail',
        notes: current.notes,
        ms: Date.now() - t0,
      });
      current = null;
    }
  } finally {
    writerWatcher.close();
  }

  console.log('\n--- worker_* absence (whole run) ---');
  const t0 = Date.now();
  current = { ok: true, notes: [] };
  assertionWorkerAbsence();
  results.push({
    n: '8b',
    title: 'No worker_* frame anywhere',
    status: current.ok ? 'pass' : 'fail',
    notes: current.notes,
    ms: Date.now() - t0,
  });
  current = null;

  console.log(`\n========== subagents:e2e summary  model=${model} ==========`);
  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⏭ ';
    console.log(`${icon} ${String(r.n).padStart(2)}. ${r.title}  (${(r.ms / 1000).toFixed(1)}s)`);
    for (const note of r.notes) console.log(`      ${note}`);
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  const passed = results.filter((r) => r.status === 'pass').length;
  console.log(
    `\n${passed} passed, ${failed} failed, ${results.filter((r) => r.status === 'skip').length} ` +
      `skipped in ${((Date.now() - started) / 1000).toFixed(0)}s  (model ${model})`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\nsubagents:e2e — HARNESS ERROR:', err instanceof Error ? err.stack : String(err));
  console.error(`--- last gateway log ---\n${gw.tail(40)}`);
  process.exitCode = 1;
} finally {
  await gw.stop();
}

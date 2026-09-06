/**
 * Live smoke for client location awareness.
 *
 * Boots a REAL gateway under a throwaway DASH_HOME (the user's ~/.dash is only
 * read), registers one agent, and drives turns that carry a `location` on the
 * chat frame — then asserts the MODEL's own answer reflects it.
 *
 * Why this exists: the unit tests prove `AgentState.systemPrompt` carries the
 * <environment> block, and piagent's setSystemPrompt proves it reaches pi.
 * Neither proves the model USES it, which is the actual goal.
 *
 * It drives BOTH gateway dispatch paths, because they are separate call sites:
 *   - resumable: true  → resumable-chat-hub.ts  (what web and iOS send)
 *   - resumable absent → chat-ws.ts direct path (what Mission Control sends)
 * Wiring one and not the other is invisible to a smoke that only tries one.
 *
 * Makes real (small) LLM calls, so like plugins:e2e it is NOT part of npm test.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bootGateway,
  pickModel,
  preflight,
  registerAgent,
  replyText,
  setMemoryConfig,
} from '../memory-e2e/harness.mjs';

// Deliberately somewhere the model cannot guess from anything else in the
// prompt, and far from this machine's real zone if that happens to differ.
const LOCATION = {
  timezone: 'Pacific/Auckland',
  utcOffsetMinutes: 720,
  locale: 'en-NZ',
  region: 'NZ',
};

const QUESTION =
  'Where am I roughly, and what is my local time zone? Answer in one short sentence. Do not ask me for my location — use what you already know.';

function driveTurn(gw, agentId, conversationId, text, { resumable, location, timeoutMs = 180000 }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(gw.chatUrl);
    const events = [];
    const id = randomUUID();
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
          ...(location ? { location } : {}),
          ...(resumable ? { resumable: true } : {}),
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

/**
 * The resumable hub requires the conversation to already exist -- unlike the
 * direct path, it does not create one on first message. Web and iOS both
 * create theirs through this route before sending.
 */
async function createConversation(gw, agentId) {
  const res = await fetch(`${gw.mgmtUrl}/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId, requestId: randomUUID(), title: 'location smoke' }),
  });
  if (!res.ok) throw new Error(`conversation create failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

const results = [];

function check(name, reply, { expectAware }) {
  const text = (reply.text || '').toLowerCase();
  const aware =
    text.includes('auckland') ||
    text.includes('new zealand') ||
    text.includes('nz') ||
    text.includes('utc+12') ||
    text.includes('+12');
  const ok = expectAware ? aware : !aware;
  results.push({ name, ok, aware, error: reply.error, timedOut: reply.timedOut, text: reply.text });
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (reply.error) console.log(`      error: ${reply.error}`);
  if (reply.timedOut) console.log('      TIMED OUT');
  console.log(`      reply: ${JSON.stringify(reply.text)}`);
}

async function main() {
  await preflight();
  const model = await pickModel();
  console.log(`model: ${model}`);

  const gw = await bootGateway({
    root: `${process.env.TMPDIR || '/tmp'}/dash-location-e2e`,
    mgmtPort: Number(process.env.LOCATION_E2E_MPORT || 19314),
    chatPort: Number(process.env.LOCATION_E2E_CPORT || 19214),
  });

  try {
    const agent = await registerAgent(gw, {
      name: 'location-smoke',
      model,
      systemPrompt: 'You are a concise assistant.',
    });
    const agentId = agent.id ?? agent.agentId;
    console.log(`agent: ${agentId}`);

    // Pin the post-turn memory sweep OFF, exactly as memory-e2e does and for
    // the same reason. The sweep legitimately extracts "user is in Auckland"
    // from a turn and writes it to agent memory, which IS injected into every
    // later conversation by design. Left on, the no-leakage check below is a
    // coin flip on whether the async sweep landed first -- and it would be
    // testing the memory feature, not this one.
    await setMemoryConfig(gw, agentId, { sweep: 'off' });

    // Control runs FIRST, and on its own agent: if it ran after the Auckland
    // turns, a pass/fail would not distinguish "no leakage" from "leaked".
    const controlAgent = await registerAgent(gw, {
      name: 'location-smoke-control',
      model,
      systemPrompt: 'You are a concise assistant.',
    });
    check(
      'control: no location reported, so no Auckland in the answer',
      await driveTurn(gw, controlAgent.id ?? controlAgent.agentId, randomUUID(), QUESTION, {}),
      { expectAware: false },
    );

    // 1. The path web + iOS actually use.
    const conversation = await createConversation(gw, agentId);
    check(
      'resumable path (web/iOS) sees the reported location',
      await driveTurn(gw, agentId, conversation.id, QUESTION, {
        resumable: true,
        location: LOCATION,
      }),
      { expectAware: true },
    );

    // 2. The path Mission Control uses.
    check(
      'direct path (Mission Control) sees the reported location',
      await driveTurn(gw, agentId, randomUUID(), QUESTION, { location: LOCATION }),
      { expectAware: true },
    );

    // 3. Leakage check: a NEW conversation on the SAME agent that has already
    //    seen Auckland, now sending no location. The <environment> block is
    //    rebuilt per turn from the frame, so this must not still say Auckland.
    check(
      'no leakage: same agent, new conversation, no location reported',
      await driveTurn(gw, agentId, randomUUID(), QUESTION, {}),
      { expectAware: false },
    );
    // Whatever explains a cross-conversation carry-over will show up here:
    // agent memory is injected into EVERY conversation by design, and the
    // post-turn sweep writes to it unless pinned off.
    const memRoot = join(gw.dataDir ?? '', 'memory', agentId);
    try {
      const files = await readdir(memRoot);
      console.log(`\nagent memory files (${memRoot}): ${JSON.stringify(files)}`);
      for (const f of files) {
        console.log(`--- ${f} ---\n${await readFile(join(memRoot, f), 'utf8')}`);
      }
    } catch (err) {
      console.log(`\nagent memory dir absent or unreadable: ${memRoot} (${err.code ?? err})`);
    }
  } finally {
    await gw.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

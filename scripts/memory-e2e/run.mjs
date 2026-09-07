// Agent-memory live E2E smoke.
//
// Boots a REAL gateway under an isolated temp DASH_HOME, registers one agent
// with memory on, and drives three turns over the chat WebSocket — each in its
// OWN conversation — to prove the whole loop end to end:
//
//   1. save    (conversation A) "remember my dog's name" → a `memory_saved`
//              event, exactly one memory file on disk, and that memory listed
//              in the generated MEMORY.md index.
//   2. recall  (conversation B, FRESH) "what is my dog's name?" → the answer
//              carries the fact. Nothing in conversation B's history contains
//              it, so the only way to know is the injected memory. This is the
//              assertion the whole feature exists for.
//   3. forget  (conversation C) "forget it" → a `memory_forgotten` event and
//              the file is gone.
//
// Real (small, ~cents) LLM calls, so this is NOT part of `npm test` / CI.
//
// Run:   npm run memory:e2e
// Model: $MEMORY_E2E_MODEL, else the first model in ~/.dash/gateway/agents.json.
// Prereq: a provider API key configured in the gateway (~/.dash/gateway).
//
// NOTE ON MODEL CHOICE: turn 1 and turn 3 require the model to CALL a tool
// (save_memory / forget_memory). A model that ignores tools will fail them.
// That is a real result about that model, not a broken script — rerun with
// MEMORY_E2E_MODEL pinned to a tool-using model to tell the two apart.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bootGateway,
  describeTurn,
  driveTurn,
  pickModel,
  preflight,
  registerAgent,
  setMemoryConfig,
} from './harness.mjs';

// The fact under test: arbitrary, unguessable, and impossible to answer in
// conversation B from anything except memory.
const FACT = 'Wasabi';
const INDEX_FILE = 'MEMORY.md';

let failures = 0;
const check = (ok, what, expected, got) => {
  console.log(`  ${ok ? '✅' : '❌'} ${what}`);
  if (!ok) {
    failures++;
    console.log(`       expected: ${expected}`);
    console.log(`       got:      ${got}`);
  }
  return ok;
};
/** A failed precondition for the turns that follow — report and stop. */
class Fatal extends Error {}
const require_ = (ok, what, expected, got) => {
  if (!check(ok, what, expected, got)) throw new Fatal(what);
};

const memoryFiles = async (dir) => {
  try {
    return (await readdir(dir)).filter((f) => f !== INDEX_FILE).sort();
  } catch {
    return [];
  }
};
const turnFailure = (turn) =>
  turn.error ? `ws error: ${turn.error}` : turn.timedOut ? 'turn timed out' : null;

await preflight();
const model = await pickModel();
const gw = await bootGateway();
console.log(`memory:e2e — model=${model}  node=${process.versions.node}  dataDir=${gw.dataDir}`);

try {
  const agent = await registerAgent(gw, {
    name: 'memory-e2e',
    model,
    systemPrompt:
      'You are a terse test assistant. Answer in one short sentence. When the user asks you to remember or forget something, use your memory tools directly with no preamble.',
    tools: [],
  });
  const memoryDir = join(gw.dataDir, 'memory', agent.id);
  // Pin the post-turn sweep OFF. The sweep writes memories on its own schedule
  // and would make "exactly one memory file" nondeterministic; this smoke
  // covers the agent-driven tool path, which is what the events assert.
  const memoryConfig = await setMemoryConfig(gw, agent.id, { sweep: 'off' });
  console.log(
    `registered agent id=${agent.id}  memory=${JSON.stringify(memoryConfig)}  dir=${memoryDir}\n`,
  );

  // ── Turn 1: save (conversation A) ────────────────────────────────────────
  console.log('=== turn 1 — save (conversation A) ===');
  const t1 = await driveTurn(
    gw,
    agent.id,
    'memory-e2e-a',
    `Please remember for future conversations: my dog's name is ${FACT}.`,
  );
  console.log(describeTurn(t1));
  require_(!turnFailure(t1), 'turn 1 completed', 'a finished turn', turnFailure(t1));
  const saved = t1.events.find((e) => e.type === 'memory_saved');
  require_(
    !!saved,
    'turn 1 emitted memory_saved',
    'a memory_saved event',
    `events: ${t1.events.map((e) => e.type).join(', ') || '(none)'}`,
  );
  const name = saved.name;
  const files1 = await memoryFiles(memoryDir);
  require_(
    files1.length === 1,
    'exactly one memory file on disk',
    `1 file in ${memoryDir}`,
    `${files1.length}: [${files1.join(', ')}]`,
  );
  check(
    files1[0] === `${name}.md`,
    'the file on disk is the one the event named',
    `${name}.md`,
    files1[0],
  );
  const index1 = await readFile(join(memoryDir, INDEX_FILE), 'utf8').catch(
    (e) => `<unreadable: ${e.message}>`,
  );
  check(
    index1.includes(`**${name}**`),
    `${INDEX_FILE} lists the new memory`,
    `an index line containing **${name}**`,
    JSON.stringify(index1.slice(0, 300)),
  );
  const body = await readFile(join(memoryDir, files1[0]), 'utf8').catch(() => '');
  check(
    new RegExp(FACT, 'i').test(body),
    'the memory body holds the fact',
    `/${FACT}/i in ${files1[0]}`,
    JSON.stringify(body.slice(0, 300)),
  );
  console.log(`\n--- ${INDEX_FILE} ---\n${index1.trimEnd()}\n`);

  // ── Turn 2: recall in a NEW conversation ─────────────────────────────────
  // Conversation B shares no history with A. If the reply carries the fact, it
  // came from the memory the gateway injected into this turn.
  console.log('=== turn 2 — recall in a NEW conversation (B) ===');
  const t2 = await driveTurn(gw, agent.id, 'memory-e2e-b', "What is my dog's name?");
  console.log(describeTurn(t2));
  require_(!turnFailure(t2), 'turn 2 completed', 'a finished turn', turnFailure(t2));
  check(
    new RegExp(FACT, 'i').test(t2.text),
    'the reply in the new conversation carries the remembered fact',
    `/${FACT}/i in the reply`,
    JSON.stringify(t2.text.slice(0, 300)) || '(empty reply)',
  );
  // Diagnostic only, not an assertion: the index is injected every turn, so a
  // model may answer straight from it or open the entry with recall_memory.
  // Both are automatic recall; which one happened is worth seeing in the log.
  const usedRecallTool = t2.events.some(
    (e) => e.type === 'tool_use_start' && e.name === 'recall_memory',
  );
  console.log(
    `  ℹ recall path: ${usedRecallTool ? 'recall_memory tool call' : 'injected index / recalled memories (no tool call)'}`,
  );

  // ── Turn 3: forget ───────────────────────────────────────────────────────
  console.log('\n=== turn 3 — forget (conversation C) ===');
  const t3 = await driveTurn(
    gw,
    agent.id,
    'memory-e2e-c',
    'Please forget what you remember about my dog — delete that memory.',
  );
  console.log(describeTurn(t3));
  require_(!turnFailure(t3), 'turn 3 completed', 'a finished turn', turnFailure(t3));
  const forgotten = t3.events.find((e) => e.type === 'memory_forgotten');
  check(
    !!forgotten,
    'turn 3 emitted memory_forgotten',
    'a memory_forgotten event',
    `events: ${t3.events.map((e) => e.type).join(', ') || '(none)'}`,
  );
  if (forgotten) {
    check(
      forgotten.name === name,
      'memory_forgotten named the memory saved in turn 1',
      name,
      forgotten.name,
    );
  }
  const files3 = await memoryFiles(memoryDir);
  check(
    files3.length === 0,
    'no memory files remain on disk',
    `0 files in ${memoryDir}`,
    `${files3.length}: [${files3.join(', ')}]`,
  );

  console.log(
    `\n========== memory:e2e ${failures === 0 ? 'PASS' : `FAIL — ${failures} assertion(s)`} (model=${model}) ==========`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  if (err instanceof Fatal) {
    console.error(
      `\n========== memory:e2e FAIL — stopped at: ${err.message} (model=${model}) ==========`,
    );
  } else {
    console.error('\nmemory:e2e — HARNESS ERROR:', err.message);
    console.error(`--- last gateway log ---\n${gw.tail(30)}`);
  }
  process.exitCode = 1;
} finally {
  await gw.stop();
}

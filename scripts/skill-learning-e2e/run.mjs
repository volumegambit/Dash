// Automatic skill-learning live E2E smoke.
//
// Boots a REAL gateway under an isolated temp DASH_HOME, registers one agent
// with learning on, and proves the whole loop end to end:
//
//   1. work    Drive a turn that makes several real tool calls. This is what
//              the effort gate exists to detect; a chat-only turn would (by
//              design) teach nothing and cost nothing.
//   2. learn   Poll the agent's managed skills directory until the post-turn
//              review lands. Assert a skill directory appears carrying the
//              `.source` = agent marker and a `lessons.json` with at least one
//              lesson whose text is non-empty.
//   3. carry   Ask for the agent's skills again and assert the learned skill is
//              in the catalogue — i.e. a LATER session can actually see it.
//              That is the assertion the whole feature exists for.
//
// The review runs on the agent's own model and is unattended, so what it
// chooses to record is not deterministic. The assertions therefore pin the
// MECHANISM (a lesson book was created, owned, non-empty and discoverable) and
// never the wording of a specific lesson.
//
// Real (small, ~cents) LLM calls, so this is NOT part of `npm test` / CI.
//
// Run:   npm run skills:e2e
// Model: $SKILLS_E2E_MODEL, else $MEMORY_E2E_MODEL, else the first model in
//        ~/.dash/gateway/agents.json.
// Prereq: Node >= 22.12 and a provider API key configured in ~/.dash/gateway.
//
// NOTE ON MODEL CHOICE: step 1 needs a model that actually calls tools, and
// step 2 needs one that returns usable JSON from the review prompt. A model
// that does neither fails this smoke — that is a real result about the model,
// not a broken script. Pin SKILLS_E2E_MODEL to tell the two apart.
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
  sleep,
} from '../memory-e2e/harness.mjs';

/** How long to wait for the post-turn review; it runs after the turn returns. */
const REVIEW_TIMEOUT_MS = 120_000;
const REVIEW_POLL_MS = 2_000;

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
class Fatal extends Error {}
const require_ = (ok, what, expected, got) => {
  if (!check(ok, what, expected, got)) throw new Fatal(what);
};

/** Every learned lesson book under the agent's managed skills directory. */
async function readBooks(skillsDir) {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const books = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    try {
      const source = (await readFile(join(dir, '.source'), 'utf8')).trim();
      const book = JSON.parse(await readFile(join(dir, 'lessons.json'), 'utf8'));
      books.push({ dir, name: entry.name, source, book });
    } catch {
      // Not a learned skill (no marker, or no book yet).
    }
  }
  return books;
}

/** Poll until the post-turn review has written at least one lesson book. */
async function waitForReview(skillsDir) {
  const deadline = Date.now() + REVIEW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const books = await readBooks(skillsDir);
    if (books.some((b) => b.book?.bullets?.length > 0)) return books;
    await sleep(REVIEW_POLL_MS);
  }
  return await readBooks(skillsDir);
}

await preflight();
const model = process.env.SKILLS_E2E_MODEL || (await pickModel());
console.log(`\n========== skills:e2e  model=${model} ==========\n`);

const gw = await bootGateway({
  root: join(process.env.TMPDIR || '/tmp', 'dash-skills-e2e'),
  mgmtPort: Number(process.env.SKILLS_E2E_MPORT || 19313),
  chatPort: Number(process.env.SKILLS_E2E_CPORT || 19213),
});

try {
  const agent = await registerAgent(gw, {
    name: 'skills-e2e',
    model,
    systemPrompt:
      'You are a terse test assistant working in a shell. Use your tools to do what is asked, one command at a time, then answer in one short sentence.',
    tools: ['bash'],
    // Learning on, and the effort gate lowered to 2 so a short scripted task
    // reliably clears it.
    skills: { learning: 'on', minToolCalls: 2 },
  });

  // Memory is not a registration field — it is configured after the fact.
  // Turned off so its post-turn sweep cannot compete with the review.
  await setMemoryConfig(gw, agent.id, { enabled: false });

  // Managed skills are keyed by agent NAME (sessions/skills use config.name;
  // memory uses the immutable id).
  const skillsDir = join(gw.dataDir, 'skills', 'skills-e2e');
  console.log(`registered agent id=${agent.id}  skills dir=${skillsDir}\n`);

  // A resumable turn runs against an EXISTING conversation — the hub rejects a
  // send for a conversation it has never seen. Create one up front.
  const convRes = await fetch(`${gw.mgmtUrl}/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: agent.id,
      requestId: `skills-e2e-${Date.now()}`,
      title: 'skills e2e',
    }),
  });
  if (!convRes.ok) {
    throw new Error(`conversation create failed: ${convRes.status} ${await convRes.text()}`);
  }
  const conversation = await convRes.json();
  console.log(`created conversation id=${conversation.id}`);

  // --- 1. A turn that does real work ---------------------------------------
  console.log('1. work — drive a turn with several tool calls');
  const work = await driveTurn(
    gw,
    agent.id,
    conversation.id,
    'Using bash, one command at a time: create a directory called notes, ' +
      'write "alpha" into notes/a.txt, write "beta" into notes/b.txt, then ' +
      'list the directory. Report what you did in one sentence.',
    // The review is scheduled by the resumable chat hub; a non-resumable turn
    // streams directly and is never reviewed.
    { resumable: true },
  );
  console.log(`   ${describeTurn(work)}`);

  const toolCalls = work.events.filter((e) => e.type === 'tool_result').length;
  require_(
    toolCalls >= 2,
    `the turn made at least 2 tool calls (made ${toolCalls})`,
    '>= 2 tool_result events',
    `${toolCalls} — the model may not be calling tools; pin SKILLS_E2E_MODEL`,
  );

  // --- 2. The review records a lesson --------------------------------------
  console.log('\n2. learn — wait for the post-turn review');
  const books = await waitForReview(skillsDir);
  require_(
    books.length > 0,
    'the review created a learned skill',
    `>= 1 lesson book under ${skillsDir}`,
    `none after ${REVIEW_TIMEOUT_MS / 1000}s — review may have returned no deltas`,
  );

  const learned = books.find((b) => b.book?.bullets?.length > 0) ?? books[0];
  console.log(`   learned skill: ${learned.name}`);
  for (const bullet of learned.book.bullets ?? []) {
    console.log(`     - [${bullet.id}] ${bullet.text}`);
  }

  check(
    learned.source === 'agent',
    'the learned skill is marked agent-owned',
    '.source === "agent"',
    JSON.stringify(learned.source),
  );
  check(
    learned.book.version === 1,
    'the lesson book is version 1',
    '1',
    JSON.stringify(learned.book.version),
  );
  check(
    Array.isArray(learned.book.bullets) && learned.book.bullets.length > 0,
    'the lesson book holds at least one lesson',
    '>= 1 bullet',
    JSON.stringify(learned.book.bullets),
  );
  check(
    (learned.book.bullets ?? []).every(
      (b) => typeof b.text === 'string' && b.text.trim().length > 0 && typeof b.id === 'string',
    ),
    'every lesson has an id and non-empty text',
    'all bullets well-formed',
    JSON.stringify(learned.book.bullets),
  );
  check(
    (learned.book.bullets ?? []).every((b) => !b.text.includes('\n')),
    'no lesson contains a newline (flattened before storage)',
    'single-line lessons',
    JSON.stringify((learned.book.bullets ?? []).map((b) => b.text)),
  );

  const md = await readFile(join(learned.dir, 'SKILL.md'), 'utf8').catch(() => '');
  check(
    md.startsWith('---') && md.includes(`name: ${learned.name}`),
    'a valid SKILL.md was rendered beside the book',
    `frontmatter naming ${learned.name}`,
    md.slice(0, 120) || '(missing)',
  );

  // --- 3. A later session can see it ---------------------------------------
  console.log('\n3. carry — the learned skill is in the catalogue');
  const res = await fetch(`${gw.mgmtUrl}/agents/${agent.id}/skills`);
  const catalogue = res.ok ? await res.json() : [];
  const found = catalogue.find((s) => s.name === learned.name);
  check(
    Boolean(found),
    'the learned skill is discoverable by the agent',
    `"${learned.name}" in GET /agents/:id/skills`,
    catalogue.map((s) => s.name).join(', ') || '(empty)',
  );
  check(
    found?.source === 'agent',
    'the catalogue reports it as agent-created',
    'source === "agent"',
    JSON.stringify(found?.source),
  );

  console.log(
    `\n========== skills:e2e ${failures === 0 ? 'PASS' : `FAIL — ${failures} assertion(s)`} (model=${model}) ==========`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  if (err instanceof Fatal) {
    console.error(
      `\n========== skills:e2e FAIL — stopped at: ${err.message} (model=${model}) ==========`,
    );
    // The review runs in the background, so its log line is the only place a
    // silent failure shows up.
    console.error(
      `--- last gateway log ---\n${gw.tail(Number(process.env.SKILLS_E2E_TAIL || 40))}`,
    );
  } else {
    console.error('\nskills:e2e — HARNESS ERROR:', err.message);
    console.error(`--- last gateway log ---\n${gw.tail(30)}`);
  }
  process.exitCode = 1;
} finally {
  await gw.stop();
}

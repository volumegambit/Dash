import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@dash/agent';
import { SentenceChunker } from './chunker.js';
import { SpokenRenderer } from './spoken-renderer.js';
import type { SpeechItem } from './spoken-renderer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/speech/src -> repo root is three levels up.
const repoRoot = join(__dirname, '..', '..', '..');
const fixturePath = join(repoRoot, 'contracts/mobile/v1/fixtures/chat-stream.jsonl');

describe('SpokenRenderer', () => {
  it('emits nothing for a text_delta that has not completed a sentence yet', () => {
    const renderer = new SpokenRenderer();
    expect(renderer.event({ type: 'text_delta', text: 'Working on it' })).toEqual([]);
  });

  it('emits a sentence item once a text_delta completes a sentence', () => {
    const renderer = new SpokenRenderer();
    expect(renderer.event({ type: 'text_delta', text: 'Hello there. ' })).toEqual([
      { kind: 'sentence', text: 'Hello there.' },
    ]);
  });

  it('emits nothing for a thinking_delta', () => {
    const renderer = new SpokenRenderer();
    expect(renderer.event({ type: 'thinking_delta', text: 'pondering' })).toEqual([]);
  });

  it('maps tool_use_start to a status phrase via statusFor', () => {
    const cases: Array<[string, string]> = [
      ['bash', 'Running a command.'],
      ['read', 'Looking at the files.'],
      ['ls', 'Looking at the files.'],
      ['grep', 'Looking at the files.'],
      ['glob', 'Looking at the files.'],
      ['write', 'Making changes.'],
      ['edit', 'Making changes.'],
      ['web_search', 'Searching the web.'],
      ['web_fetch', 'Searching the web.'],
      ['agent', 'Delegating to a sub-agent.'],
      ['some_unknown_tool', 'Working on it.'],
    ];
    for (const [name, expected] of cases) {
      const renderer = new SpokenRenderer();
      expect(renderer.event({ type: 'tool_use_start', id: '1', name })).toEqual([
        { kind: 'status', text: expected },
      ]);
    }
  });

  it('matches tool names case-insensitively and strips an MCP server__ prefix', () => {
    const renderer = new SpokenRenderer();
    expect(renderer.event({ type: 'tool_use_start', id: '1', name: 'filesystem__Read' })).toEqual([
      { kind: 'status', text: 'Looking at the files.' },
    ]);
  });

  it('suppresses a tool status within the default 8s burst window and allows one after it elapses', () => {
    let now = 0;
    const renderer = new SpokenRenderer({ now: () => now });

    expect(renderer.event({ type: 'tool_use_start', id: '1', name: 'bash' })).toEqual([
      { kind: 'status', text: 'Running a command.' },
    ]);

    now = 7900; // 7.9s later, still inside the default 8s burst window: suppressed.
    expect(renderer.event({ type: 'tool_use_start', id: '2', name: 'read' })).toEqual([]);

    now = 8100; // 8.1s after the last *emitted* status: outside the window.
    expect(renderer.event({ type: 'tool_use_start', id: '3', name: 'read' })).toEqual([
      { kind: 'status', text: 'Looking at the files.' },
    ]);
  });

  it('honors a custom toolBurstMs', () => {
    let now = 0;
    const renderer = new SpokenRenderer({ now: () => now, toolBurstMs: 100 });
    expect(renderer.event({ type: 'tool_use_start', id: '1', name: 'bash' })).toEqual([
      { kind: 'status', text: 'Running a command.' },
    ]);
    now = 50;
    expect(renderer.event({ type: 'tool_use_start', id: '2', name: 'bash' })).toEqual([]);
    now = 150;
    expect(renderer.event({ type: 'tool_use_start', id: '3', name: 'bash' })).toEqual([
      { kind: 'status', text: 'Running a command.' },
    ]);
  });

  it('defaults now to Date.now, suppressing two back-to-back tool statuses', () => {
    const renderer = new SpokenRenderer();
    expect(renderer.event({ type: 'tool_use_start', id: '1', name: 'bash' })).toEqual([
      { kind: 'status', text: 'Running a command.' },
    ]);
    expect(renderer.event({ type: 'tool_use_start', id: '2', name: 'bash' })).toEqual([]);
  });

  it('accepts a custom chunker instance', () => {
    const renderer = new SpokenRenderer({ chunker: new SentenceChunker({ maxChars: 10 }) });
    const items = renderer.event({
      type: 'text_delta',
      text: 'this sentence has no terminator and is long',
    });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.text.length).toBeLessThanOrEqual(10);
  });

  it('flushes pending chunker text before the question item, in the same returned array', () => {
    const renderer = new SpokenRenderer();
    expect(renderer.event({ type: 'text_delta', text: 'Partial sentence without end' })).toEqual(
      [],
    );

    const items = renderer.event({
      type: 'question',
      id: 'q1',
      question: 'Continue?',
      options: ['Yes', 'No'],
    });

    expect(items).toEqual([
      { kind: 'sentence', text: 'Partial sentence without end' },
      { kind: 'question', text: 'Continue? Yes, or No?', questionId: 'q1' },
    ]);
  });

  it('renders a question with no options without an options clause', () => {
    const renderer = new SpokenRenderer();
    const items = renderer.event({
      type: 'question',
      id: 'q2',
      question: 'What is your name?',
      options: [],
    });
    expect(items).toEqual([{ kind: 'question', text: 'What is your name?', questionId: 'q2' }]);
  });

  it('emits the error status once per renderer instance, not on a repeat error', () => {
    const renderer = new SpokenRenderer();
    expect(renderer.event({ type: 'error', error: new Error('boom') })).toEqual([
      { kind: 'status', text: 'Something went wrong. boom' },
    ]);
    expect(renderer.event({ type: 'error', error: new Error('boom again') })).toEqual([]);
  });

  it('falls back to a default message when the error has no message', () => {
    const renderer = new SpokenRenderer();
    expect(renderer.event({ type: 'error', error: new Error('') })).toEqual([
      { kind: 'status', text: 'Something went wrong. Unknown error.' },
    ]);
  });

  it('flushes pending chunker text on a response event', () => {
    const renderer = new SpokenRenderer();
    expect(renderer.event({ type: 'text_delta', text: 'Trailing text' })).toEqual([]);
    expect(
      renderer.event({
        type: 'response',
        content: 'Trailing text',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).toEqual([{ kind: 'sentence', text: 'Trailing text' }]);
  });

  it('returns [] for every other event type', () => {
    const renderer = new SpokenRenderer();
    const events: AgentEvent[] = [
      { type: 'tool_use_delta', partial_json: '{}' },
      { type: 'tool_result', id: '1', name: 'bash', content: 'ok' },
      { type: 'file_changed', files: ['a.ts'] },
      { type: 'agent_spawned', name: 'sub' },
      { type: 'agent_retry', attempt: 1, reason: 'timeout' },
      { type: 'context_compacted', overflow: false },
      { type: 'skill_loaded', name: 'foo' },
      { type: 'mcp_server_error', server: 's', error: 'e' },
    ];
    for (const event of events) {
      expect(renderer.event(event)).toEqual([]);
    }
  });

  it('end() flushes any pending sentence and is idempotent', () => {
    const renderer = new SpokenRenderer();
    expect(renderer.event({ type: 'text_delta', text: 'Final words' })).toEqual([]);
    expect(renderer.end()).toEqual([{ kind: 'sentence', text: 'Final words' }]);
    expect(renderer.end()).toEqual([]);
  });

  it('renders the recorded chat-stream fixture to a pinned list of speech items', () => {
    const lines = readFileSync(fixturePath, 'utf8').trim().split('\n');
    const frames = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    const renderer = new SpokenRenderer();
    const items: SpeechItem[] = [];
    for (const frame of frames) {
      if (frame.type === 'event') {
        items.push(...renderer.event(frame.event as AgentEvent));
      }
    }
    items.push(...renderer.end());

    expect(items).toEqual([
      { kind: 'sentence', text: 'Ready' },
      {
        kind: 'question',
        text: 'Confirm mobile access? Yes, or No?',
        questionId: 'question-01',
      },
    ]);
  });
});

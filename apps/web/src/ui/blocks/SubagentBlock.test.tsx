import type {
  ConversationContent,
  ConversationMessage,
  MobileAgentEvent,
} from '@dash/mobile-contract';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { create } from 'zustand';
import type { SubagentFacts, WebAppState } from '../../state/store.js';
import { WebAppStoreContext } from '../Shell.js';
import { ContentBlocks } from './ContentBlocks.js';

/**
 * Real `Markdown`, counted. Every message in a child's transcript renders
 * one, so this is the cheapest honest measure of how far a keystroke in the
 * body composer fans out (round 3, ruling 3): the composer and the row it
 * sits in must not share a `subagents` key, or `patchSubagent`'s fresh
 * entry object re-renders the entire nested transcript per character.
 */
let markdownRenders = 0;
vi.mock('./Markdown.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('./Markdown.js');
  return {
    ...actual,
    Markdown: (props: Parameters<typeof actual.Markdown>[0]) => {
      markdownRenders += 1;
      return actual.Markdown(props);
    },
  };
});

const CHILD = 'child-1';
const STARTED_AT = '2026-09-04T10:00:00.000Z';
/** Every test runs with the clock pinned here, so a running row's elapsed is
 * deterministic (`5s` for a child started at `STARTED_AT`). */
const NOW = '2026-09-04T10:00:05.000Z';

function started(overrides: Record<string, unknown> = {}): MobileAgentEvent {
  return {
    type: 'subagent_started',
    subagentId: CHILD,
    subagentType: 'Explore',
    description: 'Map gateway internals',
    prompt: 'Find every websocket entry point',
    model: 'sonnet',
    background: false,
    depth: 1,
    startedAt: STARTED_AT,
    ...overrides,
  };
}

function progress(overrides: Record<string, unknown> = {}): MobileAgentEvent {
  return {
    type: 'subagent_progress',
    subagentId: CHILD,
    status: 'running',
    toolCallCount: 3,
    detail: 'Reading chat-ws.ts',
    ...overrides,
  };
}

function finished(overrides: Record<string, unknown> = {}): MobileAgentEvent {
  return {
    type: 'subagent_finished',
    subagentId: CHILD,
    subagentType: 'Explore',
    description: 'Map gateway internals',
    status: 'done',
    report: '## Findings\n\nEvery entry point is in chat-ws.ts.',
    toolCallCount: 7,
    startedAt: STARTED_AT,
    endedAt: '2026-09-04T10:01:12.000Z',
    ...overrides,
  };
}

interface StoreSpies {
  loadSubagentTranscript: ReturnType<typeof vi.fn>;
  subscribeSubagent: ReturnType<typeof vi.fn>;
  unsubscribeSubagent: ReturnType<typeof vi.fn>;
  sendToSubagent: ReturnType<typeof vi.fn>;
}

type ScriptedStore = ReturnType<typeof scriptStore>;

/** A hand-scripted stand-in for the real store: `SubagentBlock` only ever
 * reads `transcripts`/`subagents` and calls the four sub-agent actions, so
 * a plain zustand store carrying those is enough to drive every branch here
 * without booting a socket. */
function scriptStore(initial: Partial<WebAppState> = {}) {
  const spies: StoreSpies = {
    loadSubagentTranscript: vi.fn(async () => {}),
    subscribeSubagent: vi.fn(),
    unsubscribeSubagent: vi.fn(),
    sendToSubagent: vi.fn(async () => {}),
  };
  const store = create<WebAppState>(
    (set) =>
      ({
        conversations: [],
        transcripts: {},
        subagents: {},
        connection: 'connected',
        // The real reducer, not a spy: expansion, drafts and the composer's
        // error line living in the store is the whole point of fix item 1 and
        // of round 2's I-a, so the tests drive the real thing.
        patchSubagent: (key: string, patch: Record<string, unknown>) =>
          set((state) => ({
            subagents: { ...state.subagents, [key]: { ...state.subagents[key], ...patch } },
          })),
        ...spies,
        ...initial,
      }) as unknown as WebAppState,
  );
  return { store, ...spies };
}

function renderEvents(
  events: MobileAgentEvent[],
  opts: { streaming?: boolean; scripted?: ScriptedStore } = {},
) {
  const content: ConversationContent = { type: 'assistant', events };
  return render(
    <WebAppStoreContext.Provider value={opts.scripted?.store ?? null}>
      <ContentBlocks content={content} streaming={opts.streaming ?? false} />
    </WebAppStoreContext.Provider>,
  );
}

/** The collapse toggle of the row for `subagentId` — the FIRST button inside
 * it, since an expanded row also carries the composer's Send button. */
function rowHeader(subagentId: string = CHILD): HTMLElement {
  const row = screen
    .getAllByTestId('subagent-block')
    .find((candidate) => candidate.getAttribute('data-subagent-id') === subagentId);
  if (!row) throw new Error(`no subagent row for ${subagentId}`);
  return within(row).getAllByRole('button')[0];
}

function childMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'child-msg-1',
    conversationId: CHILD,
    turnId: 'child-turn-1',
    ordinal: 1,
    role: 'assistant',
    status: 'completed',
    content: { type: 'assistant', events: [{ type: 'text_delta', text: 'Found three of them.' }] },
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    ...overrides,
  };
}

describe('SubagentBlock', () => {
  beforeEach(() => {
    markdownRenders = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('collapsed row (§8.1)', () => {
    it('renders type, description and live meta from a started+progress pair', () => {
      renderEvents([started(), progress()], { streaming: true });

      const row = screen.getByTestId('subagent-block');
      expect(row.getAttribute('data-status')).toBe('running');
      expect(row.getAttribute('data-subagent-id')).toBe(CHILD);
      expect(within(row).getByText('Explore')).toBeTruthy();
      expect(within(row).getByText('Map gateway internals')).toBeTruthy();
      expect(within(row).getByText('3 tool uses · 5s')).toBeTruthy();
      expect(row.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    });

    it('freezes elapsed on endedAt once the child is terminal', () => {
      renderEvents([started(), finished()], { streaming: true });

      const row = screen.getByTestId('subagent-block');
      expect(row.getAttribute('data-status')).toBe('done');
      expect(within(row).getByText('7 tool uses · 1m 12s')).toBeTruthy();
    });

    // Fix item 3: a child terminalized at end of stream has no `endedAt`, so
    // its duration is simply unknown — showing `Date.now() - startedAt` would
    // report how long ago it started, which after a page reload reads as
    // hours. Ruling 5's "no usable timestamp shows nothing" covers this too.
    it('shows no elapsed on a terminal row that never reported an endedAt', () => {
      renderEvents([started(), progress()], { streaming: false });

      const row = screen.getByTestId('subagent-block');
      expect(row.getAttribute('data-status')).toBe('cancelled');
      expect(within(row).getByText('3 tool uses')).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(3 * 60 * 60 * 1000);
      });
      expect(within(screen.getByTestId('subagent-block')).getByText('3 tool uses')).toBeTruthy();
    });

    // Ruling 5: `worker_*` carries no timestamp, so a legacy-only child folds
    // to `startedAt: ''`. No elapsed segment at all — never NaN, never 1970.
    it('shows the tool count with no elapsed for a legacy-only child with no startedAt', () => {
      renderEvents(
        [
          { type: 'worker_spawned', workerId: CHILD, role: 'reviewer', brief: 'Review the diff' },
          { type: 'worker_status', workerId: CHILD, status: 'running', detail: 'Reading' },
        ],
        { streaming: true },
      );

      const row = screen.getByTestId('subagent-block');
      expect(within(row).getByText('0 tool uses')).toBeTruthy();
      expect(row.textContent).not.toContain('NaN');
      expect(row.textContent).not.toContain('1970');
    });

    // Ruling 3: both families fold into rows, so neither may reach
    // `pushUnknown()` while task D8 still leaves the legacy mirrors on the wire.
    it('never renders an unknown-block for either event family', () => {
      renderEvents(
        [
          { type: 'worker_spawned', workerId: CHILD, role: 'reviewer', brief: 'Review the diff' },
          { type: 'agent_spawned', name: 'reviewer' },
          started(),
          progress(),
          { type: 'worker_status', workerId: CHILD, status: 'running' },
          { type: 'worker_done', workerId: CHILD, status: 'done', report: 'ok' },
          finished(),
        ],
        { streaming: true },
      );

      expect(screen.queryByTestId('unknown-block')).toBeNull();
    });

    it('folds a child that emits both families into exactly one row', () => {
      renderEvents(
        [
          { type: 'worker_spawned', workerId: CHILD, role: 'reviewer', brief: 'Review the diff' },
          started(),
          progress(),
        ],
        { streaming: true },
      );

      expect(screen.getAllByTestId('subagent-block')).toHaveLength(1);
    });

    // Ruling 4: pre-D8 the anchor is the `worker_spawned` mirror, not the
    // canonical start — the row must still render between the surrounding text.
    it('anchors the row at the legacy mirror when that is what came first', () => {
      const { container } = renderEvents(
        [
          { type: 'text_delta', text: 'Spawning a scout.' },
          { type: 'worker_spawned', workerId: CHILD, role: 'reviewer', brief: 'Review the diff' },
          started(),
          { type: 'text_delta', text: 'Waiting on it now.' },
        ],
        { streaming: true },
      );

      const order = [...container.querySelectorAll('.md-p, [data-testid="subagent-block"]')].map(
        (node) => node.textContent ?? '',
      );
      expect(order[0]).toBe('Spawning a scout.');
      expect(order[1]).toContain('Map gateway internals');
      expect(order[2]).toBe('Waiting on it now.');
    });

    it('offers an inline reply form while the child is waiting on input', async () => {
      const scripted = scriptStore();
      renderEvents(
        [
          started(),
          progress({ status: 'waiting_input', question: 'Should I read the tests too?' }),
        ],
        { streaming: true, scripted },
      );

      const row = screen.getByTestId('subagent-block');
      expect(row.getAttribute('data-status')).toBe('waiting');
      expect(within(row).getByText('Should I read the tests too?')).toBeTruthy();

      const reply = screen.getByTestId('subagent-reply');
      fireEvent.change(within(reply).getByRole('textbox'), { target: { value: 'yes please' } });
      // `submit` is async (fix item 5's failure feedback), so without `act`
      // its `setSending`/`patchUi` land after the test body — three React
      // "not wrapped in act(...)" warnings, and an assertion against state
      // that has not settled.
      await act(async () => {
        fireEvent.submit(reply);
      });

      // No `answering` hint any more: whether this answers the parked
      // `ask_orchestrator` question or steers is the server's to decide, and
      // the store no longer needs the guess (see `sendToSubagent`).
      //
      // `optimistic: false` because the row is COLLAPSED (fix I2): it renders
      // no transcript and holds no child subscription, so there is nowhere to
      // show a local row and no `accepted` coming to reconcile one. Usually
      // this text becomes an `ask_orchestrator` tool result with no server
      // row at all — but if the question resolved between render and submit
      // it becomes a queued steer, and the row this block would have written
      // is the one D2 found duplicated.
      expect(scripted.sendToSubagent).toHaveBeenCalledWith(CHILD, 'yes please', {
        optimistic: false,
      });
    });
  });

  describe('expansion (§8.3)', () => {
    // The once-only guard moved into the store as part of fix item 1 (a
    // component-held flag is thrown away by the remounts described in the
    // "expansion survives a remount" block below), so what this asserts is the
    // ROW's half of the contract: ask on expand, hold a subscription while
    // open, release it on collapse. `store.test.ts`'s "replays a child
    // transcript only once, however many rows ask for it" covers the dedupe.
    it('asks for the child transcript and subscribes while expanded', () => {
      const scripted = scriptStore();
      renderEvents([started(), progress()], { streaming: true, scripted });

      fireEvent.click(rowHeader());
      expect(rowHeader().getAttribute('aria-expanded')).toBe('true');
      expect(scripted.loadSubagentTranscript).toHaveBeenCalledWith(CHILD);
      expect(scripted.subscribeSubagent).toHaveBeenCalledWith(CHILD);

      fireEvent.click(rowHeader());
      expect(rowHeader().getAttribute('aria-expanded')).toBe('false');
      expect(scripted.unsubscribeSubagent).toHaveBeenCalledWith(CHILD);
      expect(scripted.subscribeSubagent).toHaveBeenCalledTimes(1);
    });

    // Ruling 1: the child's transcript goes through the SAME renderer the
    // parent uses, so a nested tool call gets a real tool card, not a stub.
    it("renders the child's own transcript with the parent's components", () => {
      const scripted = scriptStore({
        transcripts: {
          [CHILD]: {
            messages: [
              childMessage({
                content: {
                  type: 'assistant',
                  events: [
                    { type: 'text_delta', text: 'Reading the gateway.' },
                    { type: 'tool_use_start', name: 'Read', input: { file_path: '/a/chat-ws.ts' } },
                    { type: 'tool_result', name: 'Read', content: 'export function chatWs()' },
                  ],
                },
              }),
            ],
            streaming: null,
          },
        },
      });
      renderEvents([started(), progress()], { streaming: true, scripted });
      fireEvent.click(within(screen.getByTestId('subagent-block')).getByRole('button'));

      const transcript = screen
        .getByTestId('subagent-block')
        .querySelector('.subagent-transcript') as HTMLElement;
      expect(transcript).toBeTruthy();
      expect(within(transcript).getByText('Reading the gateway.')).toBeTruthy();
      expect(within(transcript).getByTestId('tool-use-block')).toBeTruthy();
    });

    it("streams the child's in-flight turn live, not just its confirmed messages", () => {
      const scripted = scriptStore();
      renderEvents([started(), progress()], { streaming: true, scripted });
      fireEvent.click(within(screen.getByTestId('subagent-block')).getByRole('button'));

      act(() => {
        scripted.store.setState({
          transcripts: {
            [CHILD]: {
              messages: [],
              streaming: { type: 'assistant', events: [{ type: 'text_delta', text: 'Half a th' }] },
            },
          },
        });
      });
      expect(screen.getByText('Half a th')).toBeTruthy();

      act(() => {
        scripted.store.setState({
          transcripts: {
            [CHILD]: {
              messages: [],
              streaming: {
                type: 'assistant',
                events: [{ type: 'text_delta', text: 'Half a thought, then the rest.' }],
              },
            },
          },
        });
      });
      expect(screen.getByText('Half a thought, then the rest.')).toBeTruthy();
    });

    // Ruling 1's guard: a grandchild row still renders (it must not become
    // "Unsupported content") but never opens a transcript of its own.
    it('stops nesting at depth 1 — a grandchild row has no nested transcript', () => {
      const scripted = scriptStore({
        transcripts: {
          [CHILD]: {
            messages: [
              childMessage({
                content: {
                  type: 'assistant',
                  events: [
                    {
                      type: 'subagent_started',
                      subagentId: 'grandchild-1',
                      subagentType: 'Plan',
                      description: 'Draft the migration',
                      depth: 2,
                      startedAt: STARTED_AT,
                    },
                  ],
                },
              }),
            ],
            streaming: null,
          },
        },
      });
      renderEvents([started(), progress()], { streaming: true, scripted });
      fireEvent.click(within(screen.getByTestId('subagent-block')).getByRole('button'));

      const rows = screen.getAllByTestId('subagent-block');
      expect(rows).toHaveLength(2);
      expect(screen.queryByTestId('unknown-block')).toBeNull();

      const grandchild = rows.find(
        (row) => row.getAttribute('data-subagent-id') === 'grandchild-1',
      );
      expect(grandchild).toBeTruthy();
      fireEvent.click(within(grandchild as HTMLElement).getByRole('button'));
      expect((grandchild as HTMLElement).querySelector('.subagent-transcript')).toBeNull();
      expect(screen.queryAllByTestId('subagent-composer')).toHaveLength(1);
      expect(scripted.loadSubagentTranscript).not.toHaveBeenCalledWith('grandchild-1');
    });

    it('renders the report as markdown in the expanded body once the child is terminal', () => {
      const scripted = scriptStore();
      renderEvents([started(), finished()], { streaming: true, scripted });
      fireEvent.click(within(screen.getByTestId('subagent-block')).getByRole('button'));

      const report = screen
        .getByTestId('subagent-block')
        .querySelector('.subagent-report') as HTMLElement;
      expect(report).toBeTruthy();
      expect(report.querySelector('.md-h2')?.textContent).toBe('Findings');
      expect(within(report).getByText('Every entry point is in chat-ws.ts.')).toBeTruthy();
    });

    it('sends a follow-up turn to the child from the expanded composer', async () => {
      const scripted = scriptStore();
      renderEvents([started(), progress()], { streaming: true, scripted });
      fireEvent.click(within(screen.getByTestId('subagent-block')).getByRole('button'));

      const composer = screen.getByTestId('subagent-composer');
      fireEvent.change(within(composer).getByRole('textbox'), {
        target: { value: 'also check the relay' },
      });
      await act(async () => {
        fireEvent.submit(composer);
      });

      // Opted in: the body composer only exists while the row is open and
      // nested, which is exactly when this block has loaded the transcript
      // and holds the subscription that redeems the row (fix I2).
      expect(scripted.sendToSubagent).toHaveBeenCalledWith(CHILD, 'also check the relay', {
        optimistic: true,
      });
    });

    /**
     * Round 3, ruling 3. The body composer used to pass the bare child id as
     * its `uiKey` — the same key `useExpansion` reads — so every keystroke
     * replaced `subagents[childId]` with a fresh object and re-rendered the
     * whole expanded row, nested transcript included. It scaled with the
     * transcript, so the composer for a long-running child got slower the
     * longer it ran. `body:<child id>` gives it its own namespace, symmetrical
     * with the reply composer's `reply:<child id>`.
     */
    it('does not re-render the nested transcript on a body-composer keystroke', () => {
      const scripted = scriptStore({
        transcripts: {
          [CHILD]: {
            messages: [
              childMessage({ id: 'm1', ordinal: 1 }),
              childMessage({ id: 'm2', ordinal: 2 }),
              childMessage({ id: 'm3', ordinal: 3 }),
            ],
            streaming: null,
            pending: null,
          },
        },
      } as unknown as Partial<WebAppState>);
      renderEvents([started(), progress()], { streaming: true, scripted });
      fireEvent.click(within(screen.getByTestId('subagent-block')).getByRole('button'));
      // Opening the row renders the transcript; only what happens AFTER that
      // is the composer's fan-out.
      expect(markdownRenders).toBeGreaterThan(0);
      markdownRenders = 0;

      const composer = screen.getByTestId('subagent-composer');
      fireEvent.change(within(composer).getByRole('textbox'), { target: { value: 'a' } });
      fireEvent.change(within(composer).getByRole('textbox'), { target: { value: 'ab' } });

      expect(markdownRenders).toBe(0);
      // Still a real composer writing to a real store.
      expect((within(composer).getByRole('textbox') as HTMLInputElement).value).toBe('ab');
    });

    /**
     * Round-1 fix I3a, and the same property the keystroke test above pins,
     * from the other side. `fetchSubagentList` allocates a fresh entry AND a
     * fresh `facts` object for every child on every read — on open, on
     * reconnect, on every `subagent_started`/`subagent_finished`, and now on
     * both ends of every turn on the open conversation. Both of this
     * component's store subscriptions compared by REFERENCE against the bare
     * child-id key, so a refresh that changed nothing re-rendered the row and
     * its whole nested transcript: measured at 3 Markdown renders per
     * identical refresh on this 3-message child, against 0 for the keystroke.
     * On a fan-out of N foreground children that is ~2N+1 full nested
     * re-renders across one turn.
     *
     * The subscriptions now select what the row actually reads — a boolean
     * (`expanded`) and a boolean (`facts.oneShot`) — so an equal refresh is
     * indistinguishable from no refresh. The list-read side of the same fix
     * (skipping a field-equal write outright) is pinned in store.test.ts.
     */
    it('does not re-render the nested transcript on an identical facts refresh', () => {
      const facts = (): SubagentFacts => ({
        type: 'Explore',
        description: 'Map gateway internals',
        status: 'running',
        background: false,
        depth: 1,
        startedAt: STARTED_AT,
        toolCallCount: 3,
        oneShot: false,
      });
      const scripted = scriptStore({
        subagents: { [CHILD]: { facts: facts() } },
        transcripts: {
          [CHILD]: {
            messages: [
              childMessage({ id: 'm1', ordinal: 1 }),
              childMessage({ id: 'm2', ordinal: 2 }),
              childMessage({ id: 'm3', ordinal: 3 }),
            ],
            streaming: null,
            pending: null,
          },
        },
      } as unknown as Partial<WebAppState>);
      renderEvents([started(), progress()], { streaming: true, scripted });
      fireEvent.click(within(screen.getByTestId('subagent-block')).getByRole('button'));
      expect(markdownRenders).toBeGreaterThan(0);
      markdownRenders = 0;

      // Exactly what `fetchSubagentList` writes for an unchanged child: a
      // fresh entry object carrying a fresh, field-equal `facts`.
      act(() => {
        scripted.store.getState().patchSubagent(CHILD, { facts: facts() });
      });
      act(() => {
        scripted.store.getState().patchSubagent(CHILD, { facts: facts() });
      });

      expect(markdownRenders).toBe(0);
      // The transcript is still mounted and still the row's own — a zero that
      // came from an unmounted subtree would prove nothing.
      expect(screen.getAllByText('Found three of them.')).toHaveLength(3);
    });

    it('disables the composer for a one-shot child and says why', () => {
      const scripted = scriptStore({
        subagents: {
          [CHILD]: {
            facts: {
              type: 'Explore',
              status: 'running',
              description: 'Map gateway internals',
              prompt: 'Find every websocket entry point',
              model: 'sonnet',
              background: false,
              depth: 1,
              startedAt: STARTED_AT,
              toolCallCount: 3,
              oneShot: true,
            },
          },
        },
      } as unknown as Partial<WebAppState>);
      renderEvents([started(), progress()], { streaming: true, scripted });
      fireEvent.click(within(screen.getByTestId('subagent-block')).getByRole('button'));

      const composer = screen.getByTestId('subagent-composer');
      expect(composer.getAttribute('title')).toBe('One-shot agents cannot be resumed');
      expect((within(composer).getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
      fireEvent.submit(composer);
      expect(scripted.sendToSubagent).not.toHaveBeenCalled();
    });

    // Ruling 2: the row is keyed by `subagentId`, not by the render counter,
    // so a resumed stream that replays a leading delta the live list never had
    // must not remount the row and throw away the expansion.
    it('keeps a row expanded when a node is inserted ahead of it', () => {
      const scripted = scriptStore();
      const content = (events: MobileAgentEvent[]): ConversationContent => ({
        type: 'assistant',
        events,
      });
      const { rerender } = render(
        <WebAppStoreContext.Provider value={scripted.store}>
          <ContentBlocks content={content([started(), progress()])} streaming />
        </WebAppStoreContext.Provider>,
      );
      fireEvent.click(rowHeader());
      expect(rowHeader().getAttribute('aria-expanded')).toBe('true');

      rerender(
        <WebAppStoreContext.Provider value={scripted.store}>
          <ContentBlocks
            content={content([
              { type: 'text_delta', text: 'Replayed preamble.' },
              started(),
              progress(),
            ])}
            streaming
          />
        </WebAppStoreContext.Provider>,
      );

      expect(screen.getByText('Replayed preamble.')).toBeTruthy();
      expect(rowHeader().getAttribute('aria-expanded')).toBe('true');
    });
  });

  describe('parallel group (§8.2)', () => {
    const secondStart = started({
      subagentId: 'child-2',
      subagentType: 'Plan',
      description: 'Draft the migration',
    });

    it('wraps adjacent starts in one group with a summary line and a dot per child', () => {
      renderEvents(
        [
          started(),
          secondStart,
          progress(),
          { type: 'subagent_finished', subagentId: 'child-2', status: 'done', report: 'done' },
        ],
        { streaming: true },
      );

      const groups = screen.getAllByTestId('subagent-group');
      expect(groups).toHaveLength(1);
      expect(within(groups[0]).getByText('2 agents · 1 running · 1 done')).toBeTruthy();
      expect(groups[0].querySelectorAll('.subagent-group-dot')).toHaveLength(2);
      expect(within(groups[0]).getAllByTestId('subagent-block')).toHaveLength(2);
    });

    it('collapses and expands as a unit', () => {
      renderEvents([started(), secondStart, progress()], { streaming: true });

      const group = screen.getByTestId('subagent-group');
      const header = within(group).getAllByRole('button')[0];
      expect(header.getAttribute('aria-expanded')).toBe('true');

      fireEvent.click(header);
      expect(header.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryAllByTestId('subagent-block')).toHaveLength(0);
    });

    it('does not wrap a lone child in a group', () => {
      renderEvents([started(), progress()], { streaming: true });

      expect(screen.queryByTestId('subagent-group')).toBeNull();
      expect(screen.getAllByTestId('subagent-block')).toHaveLength(1);
    });

    // Ruling 2 at the cluster level: a lone row that becomes a group when a
    // second adjacent spawn lands mid-stream must not remount the first row.
    it('keeps the first row expanded when a second child joins it mid-stream', () => {
      const scripted = scriptStore();
      const content = (events: MobileAgentEvent[]): ConversationContent => ({
        type: 'assistant',
        events,
      });
      const { rerender } = render(
        <WebAppStoreContext.Provider value={scripted.store}>
          <ContentBlocks content={content([started()])} streaming />
        </WebAppStoreContext.Provider>,
      );
      fireEvent.click(rowHeader());

      rerender(
        <WebAppStoreContext.Provider value={scripted.store}>
          <ContentBlocks content={content([started(), secondStart])} streaming />
        </WebAppStoreContext.Provider>,
      );

      expect(screen.getAllByTestId('subagent-block')).toHaveLength(2);
      expect(screen.getByTestId('subagent-group')).toBeTruthy();
      expect(rowHeader().getAttribute('aria-expanded')).toBe('true');
    });
  });

  // Fix item 1. The expansion a user opened is state D2 invented, and two
  // things throw it away if it lives in component state: ChatView swapping the
  // in-flight message's subtree for the finalized `MessageRow` when the turn
  // ends, and a parallel group unmounting its rows when collapsed. Both also
  // drop the child's subscription and reset the fetched flag.
  describe('expansion survives a remount (§8.3, ruling 2)', () => {
    it('stays open when the whole subtree is replaced, as it is when the parent turn ends', () => {
      const scripted = scriptStore();
      const tree = (key: string) => (
        <WebAppStoreContext.Provider value={scripted.store}>
          <div key={key}>
            <ContentBlocks
              content={{ type: 'assistant', events: [started(), progress()] }}
              streaming={key === 'streaming'}
            />
          </div>
        </WebAppStoreContext.Provider>
      );
      const { rerender } = render(tree('streaming'));
      fireEvent.click(rowHeader());
      expect(rowHeader().getAttribute('aria-expanded')).toBe('true');
      expect(scripted.loadSubagentTranscript).toHaveBeenCalledTimes(1);

      // A different `key` forces React to unmount and remount the subtree —
      // exactly what ChatView does when `done` finalizes the message.
      rerender(tree('finalized'));

      expect(rowHeader().getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByTestId('subagent-composer')).toBeTruthy();
      expect(scripted.subscribeSubagent).toHaveBeenCalledWith(CHILD);
    });

    // Round 2, I-a. Expansion was hoisted for exactly this reason; the
    // composer sits INSIDE the same subtree and was left behind.
    it('keeps a half-typed follow-up across the same subtree replacement', () => {
      const scripted = scriptStore();
      const tree = (key: string) => (
        <WebAppStoreContext.Provider value={scripted.store}>
          <div key={key}>
            <ContentBlocks
              content={{ type: 'assistant', events: [started(), progress()] }}
              streaming={key === 'streaming'}
            />
          </div>
        </WebAppStoreContext.Provider>
      );
      const { rerender } = render(tree('streaming'));
      fireEvent.click(rowHeader());
      fireEvent.change(within(screen.getByTestId('subagent-composer')).getByRole('textbox'), {
        target: { value: 'half a thought' },
      });

      rerender(tree('finalized'));

      const input = within(screen.getByTestId('subagent-composer')).getByRole(
        'textbox',
      ) as HTMLInputElement;
      expect(input.value).toBe('half a thought');
    });

    // The narrower half of I-a: the refusal lands AFTER the swap. With the
    // error in component state the old instance's handler wrote to an
    // unmounted tree and the fresh one rendered nothing — "lost with zero
    // feedback" again, which is the failure fix item 5 exists to close.
    it('shows a refusal that arrives after the subtree was replaced', async () => {
      const scripted = scriptStore();
      let refuse: ((err: unknown) => void) | null = null;
      scripted.sendToSubagent.mockReturnValue(
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
      );
      const tree = (key: string) => (
        <WebAppStoreContext.Provider value={scripted.store}>
          <div key={key}>
            <ContentBlocks
              content={{ type: 'assistant', events: [started(), progress()] }}
              streaming={key === 'streaming'}
            />
          </div>
        </WebAppStoreContext.Provider>
      );
      const { rerender } = render(tree('streaming'));
      fireEvent.click(rowHeader());
      fireEvent.change(within(screen.getByTestId('subagent-composer')).getByRole('textbox'), {
        target: { value: 'in flight' },
      });
      fireEvent.submit(screen.getByTestId('subagent-composer'));

      rerender(tree('finalized'));
      await act(async () => {
        (refuse as unknown as (err: unknown) => void)(
          Object.assign(new Error('Mobile API error 409'), { detail: 'steer cap reached' }),
        );
      });

      expect(screen.getByText('steer cap reached')).toBeTruthy();
      expect(
        (within(screen.getByTestId('subagent-composer')).getByRole('textbox') as HTMLInputElement)
          .value,
      ).toBe('in flight');
    });

    /**
     * Round 3, minor 4. `sending` was the one piece of composer state still
     * local, so the remount above re-armed a composer whose send was still in
     * flight: text intact, button enabled, nothing saying anything was
     * happening. A user reading that as "it didn't send" and pressing Enter
     * again sent the follow-up twice.
     */
    it('stays disarmed across a remount while its send is still in flight', async () => {
      const scripted = scriptStore();
      let settle: (() => void) | null = null;
      scripted.sendToSubagent.mockReturnValue(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
      const tree = (key: string) => (
        <WebAppStoreContext.Provider value={scripted.store}>
          <div key={key}>
            <ContentBlocks
              content={{ type: 'assistant', events: [started(), progress()] }}
              streaming={key === 'streaming'}
            />
          </div>
        </WebAppStoreContext.Provider>
      );
      const { rerender } = render(tree('streaming'));
      fireEvent.click(rowHeader());
      fireEvent.change(within(screen.getByTestId('subagent-composer')).getByRole('textbox'), {
        target: { value: 'in flight' },
      });
      fireEvent.submit(screen.getByTestId('subagent-composer'));
      expect(scripted.sendToSubagent).toHaveBeenCalledTimes(1);

      rerender(tree('finalized'));

      const composer = screen.getByTestId('subagent-composer');
      expect((within(composer).getByRole('button') as HTMLButtonElement).disabled).toBe(true);
      // And a user who presses Enter anyway does not send it twice.
      fireEvent.submit(composer);
      expect(scripted.sendToSubagent).toHaveBeenCalledTimes(1);

      await act(async () => {
        (settle as unknown as () => void)();
      });
      expect(
        (within(screen.getByTestId('subagent-composer')).getByRole('button') as HTMLButtonElement)
          .disabled,
      ).toBe(true); // draft cleared, so Send is disabled on empty text
      expect(
        (within(screen.getByTestId('subagent-composer')).getByRole('textbox') as HTMLInputElement)
          .value,
      ).toBe('');
    });

    it('keeps every row open across a parallel group collapse and reopen', () => {
      const scripted = scriptStore();
      renderEvents(
        [
          started(),
          started({ subagentId: 'child-2', subagentType: 'Plan', description: 'Draft it' }),
          progress(),
        ],
        { streaming: true, scripted },
      );
      fireEvent.click(rowHeader());
      fireEvent.click(rowHeader('child-2'));
      expect(rowHeader().getAttribute('aria-expanded')).toBe('true');
      expect(rowHeader('child-2').getAttribute('aria-expanded')).toBe('true');

      const groupHeader = within(screen.getByTestId('subagent-group')).getAllByRole('button')[0];
      fireEvent.click(groupHeader);
      expect(screen.queryAllByTestId('subagent-block')).toHaveLength(0);
      fireEvent.click(within(screen.getByTestId('subagent-group')).getAllByRole('button')[0]);

      expect(rowHeader().getAttribute('aria-expanded')).toBe('true');
      expect(rowHeader('child-2').getAttribute('aria-expanded')).toBe('true');
    });
  });

  // Fix item 5. A follow-up typed into a child could vanish with no trace:
  // the input cleared before the send could fail, the rejection was swallowed,
  // and the optimistic row's `failed` status was never rendered.
  describe('composer failure feedback (§8.3)', () => {
    it('keeps the text and shows the refusal when the send is rejected', async () => {
      const scripted = scriptStore();
      scripted.sendToSubagent.mockRejectedValue(
        Object.assign(new Error('Mobile API error 409'), {
          detail: 'Sub-agent child-1 is one-shot and cannot be resumed',
        }),
      );
      renderEvents([started(), progress()], { streaming: true, scripted });
      fireEvent.click(rowHeader());

      const composer = screen.getByTestId('subagent-composer');
      const input = within(composer).getByRole('textbox') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'more please' } });
      await act(async () => {
        fireEvent.submit(composer);
      });

      expect(input.value).toBe('more please');
      expect(screen.getByText('Sub-agent child-1 is one-shot and cannot be resumed')).toBeTruthy();
    });

    it('clears the text and the error once a send succeeds', async () => {
      const scripted = scriptStore();
      scripted.sendToSubagent.mockRejectedValueOnce(new Error('nope'));
      renderEvents([started(), progress()], { streaming: true, scripted });
      fireEvent.click(rowHeader());

      const composer = screen.getByTestId('subagent-composer');
      const input = within(composer).getByRole('textbox') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'first' } });
      await act(async () => {
        fireEvent.submit(composer);
      });
      expect(screen.getByTestId('subagent-composer-error')).toBeTruthy();

      await act(async () => {
        fireEvent.submit(composer);
      });
      expect(input.value).toBe('');
      expect(screen.queryByTestId('subagent-composer-error')).toBeNull();
    });

    // Round 2, I-c. `sendToSubagent` is pure REST and never touches the
    // socket, so gating it on the WebSocket only stopped the user answering a
    // child parked on `ask_orchestrator` during a reconnect — and
    // `waitForQuestion` fails that child's tool call after ten minutes. A
    // request that really cannot land surfaces through the error line instead.
    it('stays usable while the socket is reconnecting, since the send is REST', async () => {
      const scripted = scriptStore({ connection: 'reconnecting' });
      renderEvents([started(), progress()], { streaming: true, scripted });
      fireEvent.click(rowHeader());

      const composer = screen.getByTestId('subagent-composer');
      const input = within(composer).getByRole('textbox') as HTMLInputElement;
      expect(input.disabled).toBe(false);
      fireEvent.change(input, { target: { value: 'keep going' } });
      await act(async () => {
        fireEvent.submit(composer);
      });
      expect(scripted.sendToSubagent).toHaveBeenCalledWith(CHILD, 'keep going', {
        optimistic: true,
      });
    });

    // Round 2, ruling 8. Round 1 widened the one-shot disable to the
    // waiting-input reply. With `coordinator.sendToChild` now exempting a live
    // child with a pending question from the one-shot refusal, that
    // affordance has to come back: an `Explore` child holds `ask_orchestrator`
    // like any other, and nothing else can answer it.
    it('lets a one-shot child that is WAITING be answered, while its body composer stays disabled', async () => {
      const scripted = scriptStore({
        subagents: {
          [CHILD]: {
            facts: {
              type: 'Explore',
              status: 'waiting_input',
              description: 'Map gateway internals',
              prompt: 'Find every websocket entry point',
              model: 'sonnet',
              background: false,
              depth: 1,
              startedAt: STARTED_AT,
              toolCallCount: 3,
              oneShot: true,
            },
          },
        },
      } as unknown as Partial<WebAppState>);
      renderEvents([started(), progress({ status: 'waiting_input', question: 'Which relay?' })], {
        streaming: true,
        scripted,
      });
      fireEvent.click(rowHeader());

      const reply = screen.getByTestId('subagent-reply');
      const input = within(reply).getByRole('textbox') as HTMLInputElement;
      expect(input.disabled).toBe(false);
      fireEvent.change(input, { target: { value: 'the staging one' } });
      await act(async () => {
        fireEvent.submit(reply);
      });
      // Open, so the reply composer opts in here even though the collapsed
      // one above does not — the choice belongs to the BLOCK's state, not to
      // which of its two composers was used.
      expect(scripted.sendToSubagent).toHaveBeenCalledWith(CHILD, 'the staging one', {
        optimistic: true,
      });

      // The body composer is still refused — a steer to a one-shot child is
      // what the coordinator rejects, and the web disable agrees with it.
      const composer = screen.getByTestId('subagent-composer');
      expect((within(composer).getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
    });

    it('disables the composer once the credential is dead', () => {
      const scripted = scriptStore({ connection: 'unauthorized' });
      renderEvents([started(), progress()], { streaming: true, scripted });
      fireEvent.click(rowHeader());

      const composer = screen.getByTestId('subagent-composer');
      expect((within(composer).getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
      fireEvent.submit(composer);
      expect(scripted.sendToSubagent).not.toHaveBeenCalled();
    });

    it("renders a failed optimistic row in the child's transcript", () => {
      const scripted = scriptStore({
        transcripts: {
          [CHILD]: {
            messages: [
              // Exactly the shape `sendToSubagent` leaves behind when the
              // resume is refused: an orchestrator-origin row marked failed.
              childMessage({
                id: 'child-msg-failed',
                role: 'user',
                origin: 'parent',
                status: 'failed',
                content: { type: 'user', text: 'never made it' },
              }),
            ],
            streaming: null,
          },
        },
      });
      renderEvents([started(), progress()], { streaming: true, scripted });
      fireEvent.click(rowHeader());

      expect(screen.getByText('never made it')).toBeTruthy();
      expect(screen.getByText('Failed to send')).toBeTruthy();
    });
  });

  describe('origin rows inside a child transcript (§8.5)', () => {
    it('renders an orchestrator message as a muted row that keeps its text', () => {
      const scripted = scriptStore({
        transcripts: {
          [CHILD]: {
            messages: [
              childMessage({
                id: 'child-msg-0',
                role: 'user',
                origin: 'parent',
                content: { type: 'user', text: 'Also check the relay handshake.' },
              }),
            ],
            streaming: null,
          },
        },
      });
      renderEvents([started(), progress()], { streaming: true, scripted });
      fireEvent.click(within(screen.getByTestId('subagent-block')).getByRole('button'));

      const row = screen.getByTestId('orchestrator-row');
      expect(row.textContent).toContain('from orchestrator');
      expect(row.textContent).toContain('Also check the relay handshake.');
      expect(screen.queryByTestId('notification-row')).toBeNull();
    });
  });
});

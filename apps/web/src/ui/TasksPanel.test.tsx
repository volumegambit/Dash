import type { MobileAgentEvent, SubagentListEntry } from '@dash/mobile-contract';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { create } from 'zustand';
import type { WebAppState } from '../state/store.js';
import { WebAppStoreContext } from './Shell.js';
import { ONE_SHOT_RESUME_TITLE, TasksPanel, countLiveSubagents } from './TasksPanel.js';
import { ContentBlocks } from './blocks/ContentBlocks.js';

const CONVERSATION = 'conv-1';
const CHILD = 'child-1';
const OTHER = 'child-2';
const STARTED_AT = '2026-09-04T10:00:00.000Z';
/** Pinned clock, so a running row's elapsed is deterministic (`45s`). */
const NOW = '2026-09-04T10:00:45.000Z';

function facts(overrides: Partial<SubagentListEntry> = {}): Omit<SubagentListEntry, 'id'> {
  const { id: _ignored, ...rest } = {
    id: CHILD,
    type: 'Explore',
    description: 'Map gateway internals',
    status: 'running' as const,
    background: false,
    depth: 1,
    startedAt: STARTED_AT,
    toolCallCount: 3,
    oneShot: false,
    ...overrides,
  };
  return rest;
}

interface StoreSpies {
  patchSubagent: ReturnType<typeof vi.fn>;
  stopSubagent: ReturnType<typeof vi.fn>;
  sendToSubagent: ReturnType<typeof vi.fn>;
  refreshSubagents: ReturnType<typeof vi.fn>;
  subscribeSubagent: ReturnType<typeof vi.fn>;
  unsubscribeSubagent: ReturnType<typeof vi.fn>;
  loadSubagentTranscript: ReturnType<typeof vi.fn>;
}

/**
 * A hand-scripted stand-in for the real store. `patchSubagent` is the REAL
 * reducer, not a spy: the panel is specified to expand a row THROUGH the
 * store rather than by touching the DOM, so the tests have to be able to see
 * a block react to it.
 */
function scriptStore(initial: Partial<WebAppState> = {}) {
  const spies: StoreSpies = {
    patchSubagent: vi.fn(),
    stopSubagent: vi.fn(async () => {}),
    sendToSubagent: vi.fn(async () => {}),
    refreshSubagents: vi.fn(async () => {}),
    subscribeSubagent: vi.fn(),
    unsubscribeSubagent: vi.fn(),
    loadSubagentTranscript: vi.fn(async () => {}),
  };
  const store = create<WebAppState>(
    (set) =>
      ({
        conversations: [],
        transcripts: {},
        subagents: {},
        subagentIds: {},
        connection: 'connected',
        ...spies,
        patchSubagent: (key: string, patch: Record<string, unknown>) => {
          spies.patchSubagent(key, patch);
          set((state) => ({
            subagents: { ...state.subagents, [key]: { ...state.subagents[key], ...patch } },
          }));
        },
        ...initial,
      }) as unknown as WebAppState,
  );
  return Object.assign(store, spies);
}

type ScriptedStore = ReturnType<typeof scriptStore>;

function renderPanel(scripted: ScriptedStore, open = true) {
  return render(
    <WebAppStoreContext.Provider value={scripted}>
      <TasksPanel conversationId={CONVERSATION} open={open} onClose={() => {}} />
    </WebAppStoreContext.Provider>,
  );
}

/** The panel beside a real transcript, so "expands the block" can be asserted
 * against the block the user would actually be looking at. */
function renderWithTranscript(scripted: ScriptedStore, events: MobileAgentEvent[]) {
  // The panel folds the PARENT's transcript to find the cluster a row sits
  // inside, so the same events have to be in the store as well as on screen.
  scripted.setState({
    transcripts: {
      [CONVERSATION]: {
        messages: [
          {
            id: 'msg-1',
            conversationId: CONVERSATION,
            turnId: 'turn-1',
            ordinal: 1,
            role: 'assistant',
            status: 'completed',
            content: { type: 'assistant', events },
            createdAt: STARTED_AT,
            updatedAt: STARTED_AT,
          },
        ],
        streaming: null,
      },
    },
  } as unknown as Partial<WebAppState>);
  return render(
    <WebAppStoreContext.Provider value={scripted}>
      <ContentBlocks content={{ type: 'assistant', events }} streaming={false} />
      <TasksPanel conversationId={CONVERSATION} open onClose={() => {}} />
    </WebAppStoreContext.Provider>,
  );
}

function startedEvent(id: string, overrides: Record<string, unknown> = {}): MobileAgentEvent {
  return {
    type: 'subagent_started',
    subagentId: id,
    subagentType: 'Explore',
    description: 'Map gateway internals',
    background: false,
    depth: 1,
    startedAt: STARTED_AT,
    ...overrides,
  } as MobileAgentEvent;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TasksPanel', () => {
  it("lists the conversation's children in the order the store holds them", () => {
    const scripted = scriptStore({
      subagentIds: { [CONVERSATION]: [CHILD, OTHER] },
      subagents: {
        [CHILD]: { facts: facts() },
        [OTHER]: { facts: facts({ type: 'Plan', description: 'Draft the migration' }) },
      },
    } as unknown as Partial<WebAppState>);
    renderPanel(scripted);

    const rows = screen.getAllByTestId(/^tasks-row-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      `tasks-row-${CHILD}`,
      `tasks-row-${OTHER}`,
    ]);
    expect(rows[0].textContent).toContain('Explore');
    expect(rows[0].textContent).toContain('Map gateway internals');
    // Elapsed comes from the SHARED formatter (`formatElapsed`), ticking off
    // the same `useElapsed` the row in the transcript uses.
    expect(rows[0].textContent).toContain('45s');
  });

  it('says so when the conversation has no children rather than rendering an empty list', () => {
    renderPanel(scriptStore());

    expect(screen.queryAllByTestId(/^tasks-row-/)).toHaveLength(0);
    expect(screen.getByTestId('subagent-tasks-panel').textContent).toContain('No agents');
  });

  /**
   * `useElapsed` returns `null` for a terminal run with no `endedAt` — the
   * duration is genuinely unknown and `Date.now() - startedAt` would answer a
   * different question. The row must then show no elapsed segment at all,
   * not an empty one with its separator.
   */
  it('shows no elapsed segment for a finished child whose end time is unknown', () => {
    const scripted = scriptStore({
      subagentIds: { [CONVERSATION]: [CHILD] },
      subagents: { [CHILD]: { facts: facts({ status: 'cancelled' }) } },
    } as unknown as Partial<WebAppState>);
    renderPanel(scripted);

    const row = screen.getByTestId(`tasks-row-${CHILD}`);
    expect(row.textContent).toContain('cancelled');
    expect(row.textContent).not.toContain('·');
    expect(row.textContent).not.toMatch(/\d+s/);
  });

  describe('stop', () => {
    it('cancels through the store, which is the REST route', async () => {
      const scripted = scriptStore({
        subagentIds: { [CONVERSATION]: [CHILD] },
        subagents: { [CHILD]: { facts: facts() } },
      } as unknown as Partial<WebAppState>);
      renderPanel(scripted);

      await act(async () => {
        fireEvent.click(screen.getByTestId(`tasks-stop-${CHILD}`));
      });

      expect(scripted.stopSubagent).toHaveBeenCalledWith(CHILD);
    });

    it('offers no stop for a child that has already finished', () => {
      const scripted = scriptStore({
        subagentIds: { [CONVERSATION]: [CHILD] },
        subagents: { [CHILD]: { facts: facts({ status: 'done' }) } },
      } as unknown as Partial<WebAppState>);
      renderPanel(scripted);

      expect(screen.queryByTestId(`tasks-stop-${CHILD}`)).toBeNull();
    });

    it('surfaces the reason when the stop is refused', async () => {
      const scripted = scriptStore({
        subagentIds: { [CONVERSATION]: [CHILD] },
        subagents: { [CHILD]: { facts: facts() } },
        stopSubagent: vi.fn(async () => {
          throw Object.assign(new Error('nope'), { detail: 'Sub-agent is not yours to stop' });
        }),
      } as unknown as Partial<WebAppState>);
      renderPanel(scripted);

      await act(async () => {
        fireEvent.click(screen.getByTestId(`tasks-stop-${CHILD}`));
      });

      expect(screen.getByRole('alert').textContent).toBe('Sub-agent is not yours to stop');
    });
  });

  describe('resume', () => {
    it('sends the follow-up through the same store action the row composer uses', async () => {
      const scripted = scriptStore({
        subagentIds: { [CONVERSATION]: [CHILD] },
        subagents: { [CHILD]: { facts: facts({ status: 'done' }) } },
      } as unknown as Partial<WebAppState>);
      renderPanel(scripted);

      fireEvent.click(screen.getByTestId(`tasks-resume-${CHILD}`));
      const composer = screen.getByTestId(`tasks-resume-composer-${CHILD}`);
      fireEvent.change(within(composer).getByRole('textbox'), {
        target: { value: 'also check the relay' },
      });
      await act(async () => {
        fireEvent.submit(composer);
      });

      expect(scripted.sendToSubagent).toHaveBeenCalledWith(CHILD, 'also check the relay');
    });

    /** Its draft lives in the store under its own key, like every other
     * sub-agent composer, so it cannot collide with the row's expansion or
     * with the two composers in the block. */
    it('keeps its draft under a key of its own', () => {
      const scripted = scriptStore({
        subagentIds: { [CONVERSATION]: [CHILD] },
        subagents: { [CHILD]: { facts: facts({ status: 'done' }) } },
      } as unknown as Partial<WebAppState>);
      renderPanel(scripted);

      fireEvent.click(screen.getByTestId(`tasks-resume-${CHILD}`));
      const composer = screen.getByTestId(`tasks-resume-composer-${CHILD}`);
      fireEvent.change(within(composer).getByRole('textbox'), { target: { value: 'half typed' } });

      expect(scripted.getState().subagents[`tasks:${CHILD}`]?.draft).toBe('half typed');
      expect(scripted.getState().subagents[CHILD]?.draft).toBeUndefined();
    });

    it('refuses to resume a one-shot child and says why', () => {
      const scripted = scriptStore({
        subagentIds: { [CONVERSATION]: [CHILD] },
        subagents: { [CHILD]: { facts: facts({ status: 'done', oneShot: true }) } },
      } as unknown as Partial<WebAppState>);
      renderPanel(scripted);

      const resume = screen.getByTestId(`tasks-resume-${CHILD}`) as HTMLButtonElement;
      expect(resume.disabled).toBe(true);
      expect(resume.title).toBe(ONE_SHOT_RESUME_TITLE);
    });

    /** `coordinator.sendToChild` exempts a live one-shot child parked on a
     * question from the one-shot refusal — nothing else can answer it. */
    it('still lets a one-shot child that is WAITING be answered', () => {
      const scripted = scriptStore({
        subagentIds: { [CONVERSATION]: [CHILD] },
        subagents: { [CHILD]: { facts: facts({ status: 'waiting_input', oneShot: true }) } },
      } as unknown as Partial<WebAppState>);
      renderPanel(scripted);

      expect((screen.getByTestId(`tasks-resume-${CHILD}`) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
  });

  describe('clicking a row', () => {
    it('expands the block in the transcript, through the store', () => {
      const scripted = scriptStore({
        subagentIds: { [CONVERSATION]: [CHILD] },
        subagents: { [CHILD]: { facts: facts() } },
      } as unknown as Partial<WebAppState>);
      renderWithTranscript(scripted, [startedEvent(CHILD)]);
      const block = document.querySelector(`[data-subagent-id="${CHILD}"]`);
      expect(block?.getAttribute('data-expanded')).toBe('false');

      fireEvent.click(screen.getByTestId(`tasks-row-${CHILD}`));

      expect(document.querySelector(`[data-subagent-id="${CHILD}"]`)).toBe(block);
      expect(block?.getAttribute('data-expanded')).toBe('true');
      expect(scripted.getState().subagents[CHILD].expanded).toBe(true);
    });

    /**
     * A collapsed parallel group UNMOUNTS its rows (§8.2), so expanding a row
     * inside one would leave nothing on screen to scroll to. The panel opens
     * the enclosing cluster too, keyed the same way `SubagentCluster` reads
     * it.
     */
    it('opens the parallel group the row is inside', () => {
      const scripted = scriptStore({
        subagentIds: { [CONVERSATION]: [OTHER] },
        subagents: {
          [OTHER]: { facts: facts() },
          [`group:${CHILD}`]: { expanded: false },
        },
      } as unknown as Partial<WebAppState>);
      renderWithTranscript(scripted, [startedEvent(CHILD), startedEvent(OTHER)]);
      // Collapsed: the group renders, its rows do not.
      expect(document.querySelector(`[data-subagent-id="${OTHER}"]`)).toBeNull();

      fireEvent.click(screen.getByTestId(`tasks-row-${OTHER}`));

      expect(scripted.getState().subagents[`group:${CHILD}`].expanded).toBe(true);
      expect(
        document.querySelector(`[data-subagent-id="${OTHER}"]`)?.getAttribute('data-expanded'),
      ).toBe('true');
    });

    it('scrolls the block into view', () => {
      const scrollIntoView = vi.fn();
      const scripted = scriptStore({
        subagentIds: { [CONVERSATION]: [CHILD] },
        subagents: { [CHILD]: { facts: facts() } },
      } as unknown as Partial<WebAppState>);
      renderWithTranscript(scripted, [startedEvent(CHILD)]);
      const block = document.querySelector(`[data-subagent-id="${CHILD}"]`) as HTMLElement;
      block.scrollIntoView = scrollIntoView;

      fireEvent.click(screen.getByTestId(`tasks-row-${CHILD}`));

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Trap 3 from D2: child subscriptions are refcounted and their wire release
   * is deferred by a microtask. The panel does not take one — it never
   * renders a child's transcript, and a second, parallel subscription path
   * would leak a watcher for every child of every conversation the user
   * visits.
   */
  it('never subscribes to a child or fetches its transcript', () => {
    const scripted = scriptStore({
      subagentIds: { [CONVERSATION]: [CHILD, OTHER] },
      subagents: { [CHILD]: { facts: facts() }, [OTHER]: { facts: facts() } },
    } as unknown as Partial<WebAppState>);
    renderPanel(scripted);
    fireEvent.click(screen.getByTestId(`tasks-row-${CHILD}`));

    expect(scripted.subscribeSubagent).not.toHaveBeenCalled();
    expect(scripted.loadSubagentTranscript).not.toHaveBeenCalled();
  });

  describe('countLiveSubagents', () => {
    it('counts the children that have not finished, and nothing else', () => {
      const state = {
        subagentIds: { [CONVERSATION]: [CHILD, OTHER, 'child-3'] },
        subagents: {
          [CHILD]: { facts: facts({ status: 'running' }) },
          [OTHER]: { facts: facts({ status: 'waiting_input' }) },
          'child-3': { facts: facts({ status: 'done' }) },
        },
      } as unknown as WebAppState;

      expect(countLiveSubagents(state, CONVERSATION)).toBe(2);
      expect(countLiveSubagents(state, 'conv-2')).toBe(0);
      expect(countLiveSubagents(state, null)).toBe(0);
    });

    /** Every one of `max_turns`/`interrupted`/`cancelled`/`failed` is over —
     * MC's older `isTerminalStatus` knew only three of the five, which is the
     * stale copy D1's `isTerminalSubagentStatus` replaced. */
    it('treats all five terminal outcomes as finished', () => {
      const state = {
        subagentIds: { [CONVERSATION]: ['a', 'b', 'c', 'd', 'e'] },
        subagents: {
          a: { facts: facts({ status: 'done' }) },
          b: { facts: facts({ status: 'failed' }) },
          c: { facts: facts({ status: 'cancelled' }) },
          d: { facts: facts({ status: 'interrupted' }) },
          e: { facts: facts({ status: 'max_turns' }) },
        },
      } as unknown as WebAppState;

      expect(countLiveSubagents(state, CONVERSATION)).toBe(0);
    });
  });
});

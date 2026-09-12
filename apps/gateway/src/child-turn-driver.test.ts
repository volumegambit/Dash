import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
import type { MobileWsServerFrame } from '@dash/mobile-contract';
import type { ChildSpec, ChildTurnOutcome, ChildTurnRef } from '@dash/swarm';
import { ChildTurnStartError, SwarmCoordinator, childConversationId } from '@dash/swarm';
import type { AgentChatCoordinator, ChatRequest } from './agent-chat-coordinator.js';
import { createChildTurnDriver } from './child-turn-driver.js';
import type { ConversationAutoTitleService } from './conversation-auto-title.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { type ResumableChatHub, createResumableChatHub } from './resumable-chat-hub.js';

/** A chat coordinator whose every conversation replays a fixed script. */
function makeAgents(scripts: Map<string, AgentEvent[]>): AgentChatCoordinator {
  return {
    chat: (request: ChatRequest) => {
      const script = scripts.get(request.conversationId) ?? [];
      return (async function* () {
        for (const event of script) yield event;
      })();
    },
    answerQuestion: async () => {},
    cancel: () => true,
    sealSteering: async () => [],
  } as unknown as AgentChatCoordinator;
}

function specFor(childId: string, parentConversationId: string): ChildSpec {
  return {
    agentId: 'agent-01',
    agentName: 'Helper',
    runId: 'parent-turn-1',
    workerId: childId,
    childConversationId: childId,
    parentConversationId,
    parentTurnId: 'parent-turn-1',
    role: 'scout',
    brief: 'survey the repo',
    model: 'test/model',
    workspace: '/repo',
    tools: ['read'],
    extraTools: [],
    subagentType: 'general-purpose',
    description: 'survey repo',
    name: 'scout',
    depth: 1,
  };
}

describe('createChildTurnDriver', () => {
  let tmpDir: string;
  let conversations: SqliteConversationService;
  let hub: ResumableChatHub;
  let scripts: Map<string, AgentEvent[]>;
  let uuidCounter: number;

  const autoTitle: ConversationAutoTitleService = {
    schedule: () => {},
    flush: async () => {},
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'child-turn-driver-'));
    uuidCounter = 0;
    scripts = new Map();
    conversations = new SqliteConversationService({
      dataDir: tmpDir,
      uuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
    });
    hub = createResumableChatHub({
      conversations,
      agents: makeAgents(scripts),
      autoTitle,
      isAgentEnabled: () => true,
    });
  });

  afterEach(async () => {
    await hub.stop();
    conversations.close();
    await rm(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function makeDriver(hubRef: () => ResumableChatHub | undefined = () => hub) {
    const driver = createChildTurnDriver({ conversations, hub: hubRef });
    driver.attachObserver();
    return driver;
  }

  /** The row-creating half of a spawn, matching {@link specFor}. */
  function childInput(childId: string, parentConversationId: string) {
    return {
      id: childId,
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId,
      parentTurnId: 'parent-turn-1',
      title: 'survey repo',
      subagent: {
        type: 'general-purpose',
        name: 'scout',
        status: 'running' as const,
        description: 'survey repo',
        prompt: 'survey the repo',
        model: 'test/model',
        background: false,
        depth: 1,
        startedAt: '2026-09-05T00:00:00.000Z',
        toolCallCount: 0,
        oneShot: false,
      },
    };
  }

  function parentConversation() {
    return conversations.create({
      agentId: 'agent-01',
      agentName: 'Helper',
      requestId: `req-${++uuidCounter}`,
    });
  }

  it('creates a subagent conversation carrying the subagent info', () => {
    const parent = parentConversation();
    const driver = makeDriver();
    const childId = childConversationId();
    driver.prepareChild(specFor(childId, parent.id));
    driver.createChild({
      id: childId,
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: parent.id,
      parentTurnId: 'parent-turn-1',
      title: 'survey repo',
      subagent: {
        type: 'general-purpose',
        name: 'scout',
        status: 'running',
        description: 'survey repo',
        prompt: 'survey the repo',
        model: 'test/model',
        background: false,
        depth: 1,
        startedAt: '2026-09-05T00:00:00.000Z',
        toolCallCount: 0,
        oneShot: false,
      },
    });

    const row = conversations.get(childId);
    expect(row).toMatchObject({
      id: childId,
      kind: 'subagent',
      parentConversationId: parent.id,
      parentTurnId: 'parent-turn-1',
      subagent: { type: 'general-purpose', name: 'scout', status: 'running', depth: 1 },
    });
    expect(driver.listChildren(parent.id).map((c) => c.subagentId)).toEqual([childId]);
  });

  /**
   * Task C4 ruling 1: `subagent_meta` carries the USER-visible half of a child
   * and structurally cannot carry its GRANT, so resume had nothing to rebuild a
   * spec from. The driver persists the grant beside the row on every
   * `createChild` — including the idempotent one a RESUME performs, which is
   * what re-narrows a stored grant that the parent has since lost tools from.
   */
  it('persists the prepared spec GRANT beside the child row', () => {
    const parent = parentConversation();
    const driver = makeDriver();
    const childId = childConversationId();
    driver.prepareChild({
      ...specFor(childId, parent.id),
      tools: ['read', 'grep'],
      mcpTools: ['github__pr'],
      spawnableTypes: ['Explore'],
      canSpawn: true,
      skipMemory: true,
      maxTurns: 4,
      systemPrompt: 'the definition body',
    });
    driver.createChild(childInput(childId, parent.id));

    expect(conversations.getSubagentGrant(childId)).toEqual({
      tools: ['read', 'grep'],
      mcpTools: ['github__pr'],
      spawnableTypes: ['Explore'],
      canSpawn: true,
      workspace: '/repo',
      depth: 1,
      skipMemory: true,
      maxTurns: 4,
      systemPrompt: 'the definition body',
    });
  });

  /**
   * S5: the row and its grant used to be two independent writes — one
   * `createSubagent` transaction, then a bare `UPDATE` outside it — so a
   * process death between them left a durable child row with
   * `subagent_grant = NULL`. Both consumers refuse such a row for good
   * (`its grant cannot be rebuilt`), so the child could never run again.
   */
  it('writes the grant INSIDE the create — there is no second write to die between', () => {
    const parent = parentConversation();
    let separateWrites = 0;
    const fragile = new Proxy(conversations, {
      get(target, prop, receiver) {
        if (prop === 'putSubagentGrant') {
          return () => {
            separateWrites++;
            throw new Error('the process died between the two writes');
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as SqliteConversationService;

    const driver = createChildTurnDriver({ conversations: fragile, hub: () => hub });
    const childId = childConversationId();
    driver.prepareChild(specFor(childId, parent.id));
    driver.createChild(childInput(childId, parent.id));

    expect(separateWrites).toBe(0);
    expect(conversations.get(childId)).toBeTruthy();
    expect(conversations.getSubagentGrant(childId)?.tools).toEqual(['read']);
  });

  it('re-narrows the persisted grant when a resume prepares a smaller one', () => {
    const parent = parentConversation();
    const driver = makeDriver();
    const childId = childConversationId();
    driver.prepareChild({ ...specFor(childId, parent.id), tools: ['read', 'bash'] });
    driver.createChild(childInput(childId, parent.id));
    // The resume: the parent has since lost `bash`, so the child's grant does.
    driver.prepareChild({ ...specFor(childId, parent.id), tools: ['read'] });
    driver.createChild(childInput(childId, parent.id));

    expect(conversations.getSubagentGrant(childId)?.tools).toEqual(['read']);
  });

  it('round-trips the workspace an isolated child actually ran in', () => {
    const parent = parentConversation();
    const driver = makeDriver();
    const childId = childConversationId();
    driver.prepareChild(specFor(childId, parent.id));
    driver.createChild({
      id: childId,
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: parent.id,
      parentTurnId: 'parent-turn-1',
      title: 'survey repo',
      subagent: {
        type: 'general-purpose',
        status: 'running',
        description: 'survey repo',
        prompt: 'go',
        model: 'test/model',
        background: false,
        isolation: 'worktree',
        depth: 1,
        startedAt: '2026-09-05T00:00:00.000Z',
        toolCallCount: 0,
        oneShot: false,
      },
    });
    // Both are optional on the ChildTurnDriver seam; this test is about them.
    if (!driver.workspaceOf || !driver.updateChild) {
      throw new Error('the gateway child driver must expose workspaceOf + updateChild');
    }
    expect(driver.workspaceOf(childId)).toBeUndefined();

    driver.updateChild(childId, { info: { workspace: '/data/worktrees/Helper/child' } });

    expect(driver.workspaceOf(childId)).toBe('/data/worktrees/Helper/child');
    expect(conversations.get(childId)?.subagent?.workspace).toBe('/data/worktrees/Helper/child');
  });

  it('runs a child turn through the hub and reports its events and completion', async () => {
    const parent = parentConversation();
    const driver = makeDriver();
    const childId = childConversationId();
    scripts.set(childId, [
      { type: 'tool_use_start', id: 't1', name: 'read', input: {} },
      { type: 'response', content: 'the report', usage: { inputTokens: 1, outputTokens: 2 } },
    ]);
    driver.prepareChild(specFor(childId, parent.id));
    driver.createChild({
      id: childId,
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: parent.id,
      parentTurnId: 'parent-turn-1',
      title: 'survey repo',
      subagent: {
        type: 'general-purpose',
        status: 'running',
        description: 'survey repo',
        prompt: 'survey the repo',
        model: 'test/model',
        background: false,
        depth: 1,
        startedAt: '2026-09-05T00:00:00.000Z',
        toolCallCount: 0,
        oneShot: false,
      },
    });

    const seen: AgentEvent[] = [];
    const finished: Array<{ turn: ChildTurnRef; outcome: ChildTurnOutcome }> = [];
    driver.onEvent((_turn, event) => seen.push(event));
    driver.onFinish((turn, outcome) => finished.push({ turn, outcome }));

    const { turnId } = driver.startTurn({
      agentId: 'agent-01',
      conversationId: childId,
      text: 'survey the repo',
      origin: 'parent',
    });
    await vi.waitFor(() => expect(finished).toHaveLength(1));

    expect(seen.map((e) => e.type)).toEqual(['tool_use_start', 'response']);
    expect(finished[0]).toMatchObject({ outcome: 'completed', turn: { conversationId: childId } });
    // The child's turn is a REAL persisted turn on its own conversation.
    const messages = conversations.listMessages({ conversationId: childId, limit: 10 });
    expect(messages.items[0]).toMatchObject({ role: 'user', origin: 'parent', turnId });
  });

  it("carries a startTurn requestId onto the child turn's accepted frame", async () => {
    const parent = parentConversation();
    const driver = makeDriver();
    const childId = childConversationId();
    scripts.set(childId, [
      { type: 'response', content: 'ok', usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    driver.prepareChild(specFor(childId, parent.id));
    createRow(driver, childId, parent.id);

    // A client watching the child conversation is the only audience for a
    // child turn's frames — that is the sink the correlation id has to reach.
    const frames: MobileWsServerFrame[] = [];
    hub.subscribe('agent-01', childId, { send: (frame) => frames.push(frame) });

    driver.startTurn({
      agentId: 'agent-01',
      conversationId: childId,
      text: 'the follow-up',
      origin: 'parent',
      requestId: 'req-from-the-client',
    });
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'done')).toBe(true));

    expect(frames[0]).toMatchObject({
      type: 'accepted',
      origin: 'parent',
      requestId: 'req-from-the-client',
    });
  });

  it('starts a child turn with NO requestId when none was supplied', async () => {
    const parent = parentConversation();
    const driver = makeDriver();
    const childId = childConversationId();
    scripts.set(childId, [
      { type: 'response', content: 'ok', usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    driver.prepareChild(specFor(childId, parent.id));
    createRow(driver, childId, parent.id);
    const frames: MobileWsServerFrame[] = [];
    hub.subscribe('agent-01', childId, { send: (frame) => frames.push(frame) });

    driver.startTurn({
      agentId: 'agent-01',
      conversationId: childId,
      text: 'the brief',
      origin: 'parent',
    });
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'done')).toBe(true));

    expect(Object.hasOwn(frames[0], 'requestId')).toBe(false);
  });

  it('does not report a PARENT conversation turn as a child turn', async () => {
    const parent = parentConversation();
    const driver = makeDriver();
    scripts.set(parent.id, [
      { type: 'response', content: 'hi', usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    const seen: AgentEvent[] = [];
    driver.onEvent((_turn, event) => seen.push(event));

    hub.startSystemTurn({
      agentId: 'agent-01',
      conversationId: parent.id,
      text: 'wake up',
      origin: 'notification',
    });
    await vi.waitFor(() => expect(conversations.get(parent.id)?.activeTurnId).toBeNull());

    expect(seen).toEqual([]);
  });

  it('carries the failure text of a failed child turn', async () => {
    const parent = parentConversation();
    const driver = makeDriver();
    const childId = childConversationId();
    scripts.set(childId, [{ type: 'error', error: new Error('provider refused') }]);
    driver.prepareChild(specFor(childId, parent.id));
    createRow(driver, childId, parent.id);

    const finished: Array<{ outcome: ChildTurnOutcome; error?: string }> = [];
    driver.onFinish((_turn, outcome, error) => finished.push({ outcome, error }));
    driver.startTurn({
      agentId: 'agent-01',
      conversationId: childId,
      text: 'go',
      origin: 'parent',
    });
    await vi.waitFor(() => expect(finished).toHaveLength(1));

    expect(finished[0]).toEqual({ outcome: 'failed', error: 'provider refused' });
  });

  describe('startTurn failure shapes', () => {
    it('classifies a busy conversation as retryable "busy"', () => {
      const parent = parentConversation();
      const driver = makeDriver();
      const childId = childConversationId();
      scripts.set(childId, []);
      driver.prepareChild(specFor(childId, parent.id));
      createRow(driver, childId, parent.id);
      // Take the child's turn lease with a turn that never finishes.
      conversations.acceptTurn({
        agentId: 'agent-01',
        conversationId: childId,
        turnId: 'squatter',
        text: 'holding the lease',
        origin: 'parent',
      });

      let thrown: unknown;
      try {
        driver.startTurn({
          agentId: 'agent-01',
          conversationId: childId,
          text: 'go',
          origin: 'parent',
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ChildTurnStartError);
      expect((thrown as ChildTurnStartError).reason).toBe('busy');
    });

    it('does NOT mistake a stopped hub — which throws a BARE Error — for busy', async () => {
      const parent = parentConversation();
      const driver = makeDriver();
      const childId = childConversationId();
      driver.prepareChild(specFor(childId, parent.id));
      createRow(driver, childId, parent.id);
      await hub.stop();

      let thrown: unknown;
      try {
        driver.startTurn({
          agentId: 'agent-01',
          conversationId: childId,
          text: 'go',
          origin: 'parent',
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ChildTurnStartError);
      expect((thrown as ChildTurnStartError).reason).toBe('stopped');
      expect((thrown as ChildTurnStartError).message).toMatch(/stopped/);
    });

    it('reports "stopped" before the hub exists at all', () => {
      const driver = createChildTurnDriver({ conversations, hub: () => undefined });
      expect(() =>
        driver.startTurn({
          agentId: 'agent-01',
          conversationId: 'sub_00000000000000000000000000',
          text: 'go',
          origin: 'parent',
        }),
      ).toThrow(ChildTurnStartError);
    });
  });

  it('reports a child as not alive once a cascading delete tombstones it', () => {
    const parent = parentConversation();
    const driver = makeDriver();
    const childId = childConversationId();
    driver.prepareChild(specFor(childId, parent.id));
    createRow(driver, childId, parent.id);
    expect(driver.isChildAlive(childId)).toBe(true);

    conversations.delete(parent.id, conversations.get(parent.id)?.revision ?? 1);

    expect(driver.isChildAlive(childId)).toBe(false);
  });

  it('a spawn through the coordinator becomes a real child conversation', async () => {
    const parent = parentConversation();
    const driver = makeDriver();
    const coordinator = new SwarmCoordinator({ childDriver: driver });
    coordinator.attach({
      agentId: 'agent-01',
      agentName: 'Helper',
      conversationId: parent.id,
      messageId: 'parent-turn-1',
      orchestratorModel: 'test/model',
      workspace: '/repo',
    });

    // The script is keyed by the child's conversation id, which only exists
    // once the spawn mints it — register a lazy default for any child.
    const originalGet = scripts.get.bind(scripts);
    scripts.get = (id: string) =>
      originalGet(id) ?? [
        { type: 'response', content: 'child report', usage: { inputTokens: 1, outputTokens: 1 } },
      ];

    const { subagentId } = coordinator.spawnChild(
      {
        agentId: 'agent-01',
        agentName: 'Helper',
        conversationId: parent.id,
        turnId: 'parent-turn-1',
        depth: 0,
        workspace: '/repo',
      },
      { role: 'scout', brief: 'survey the repo', description: 'survey repo', name: 'scout' },
    );

    const snap = await coordinator.waitChild(subagentId);
    expect(snap.status).toBe('done');
    expect(snap.report).toBe('child report');

    const row = conversations.get(subagentId);
    expect(row).toMatchObject({
      kind: 'subagent',
      parentConversationId: parent.id,
      parentTurnId: 'parent-turn-1',
      subagent: { status: 'done', report: 'child report', name: 'scout', depth: 1 },
    });
    // …and it stays addressable from the parent after the turn.
    expect(coordinator.findChild(parent.id, 'scout')?.subagentId).toBe(subagentId);
  });

  it('a RESUME rewrites the run-scoped meta, so nothing reads run 1 beside a running run 2', async () => {
    // `Date` only: the hub and the handle's heartbeat keep their real timers,
    // and the two runs get distinguishable `startedAt`s that a same-millisecond
    // spawn/resume could not give them.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-08T10:00:00.000Z'));
    const parent = parentConversation();
    const driver = makeDriver();
    const coordinator = new SwarmCoordinator({
      childDriver: driver,
      // `onChildTerminal` drops the resolved spec on purpose, so every resume
      // goes through the rebuild. What the rebuild produces is
      // `subagent-resume.test.ts`'s subject; here it only has to succeed.
      reconstructChildSpec: (id) => specFor(id, parent.id),
    });
    coordinator.attach({
      agentId: 'agent-01',
      agentName: 'Helper',
      conversationId: parent.id,
      messageId: 'parent-turn-1',
      orchestratorModel: 'test/model',
      workspace: '/repo',
    });

    const originalGet = scripts.get.bind(scripts);
    scripts.get = (id: string) =>
      originalGet(id) ?? [
        { type: 'tool_use_start', id: 't-1', name: 'read', input: {} },
        { type: 'response', content: 'run one report', usage: { inputTokens: 5, outputTokens: 7 } },
      ];

    const { subagentId } = coordinator.spawnChild(
      {
        agentId: 'agent-01',
        agentName: 'Helper',
        conversationId: parent.id,
        turnId: 'parent-turn-1',
        depth: 0,
        workspace: '/repo',
      },
      { role: 'scout', brief: 'survey the repo', description: 'survey repo', name: 'scout' },
    );
    await coordinator.waitChild(subagentId);

    const afterRunOne = conversations.get(subagentId)?.subagent;
    expect(afterRunOne?.status).toBe('done');
    expect(afterRunOne?.startedAt).toBe('2026-09-08T10:00:00.000Z');
    expect(afterRunOne?.endedAt).toBe('2026-09-08T10:00:00.000Z');
    expect(afterRunOne?.report).toBe('run one report');
    expect(afterRunOne?.toolCallCount).toBe(1);
    expect(afterRunOne?.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(afterRunOne?.workspace).toBe('/repo');

    // A day later the user taps Resume. `ChildHandle.start()` persists before
    // the route answers, so the row is read SYNCHRONOUSLY, exactly as the GET
    // behind `POST /subagents/:id/resume` reads it.
    vi.setSystemTime(new Date('2026-09-09T12:14:00.000Z'));
    coordinator.sendToChild(parent.id, 'scout', 'pick this back up');

    const resumed = conversations.get(subagentId)?.subagent;
    expect(resumed?.status).toBe('running');
    // The four fields that describe a RUN, not a child: run 2's start, and no
    // trace of run 1. A `running` row carrying run 1's `startedAt` is what
    // makes every client tick an elapsed upward from yesterday.
    // `soft`, so one run names every field that is still run 1's.
    expect.soft(resumed?.startedAt).toBe('2026-09-09T12:14:00.000Z');
    expect.soft(resumed?.endedAt).toBeUndefined();
    expect.soft(resumed?.report).toBeUndefined();
    expect.soft(resumed?.usage).toBeUndefined();
    expect.soft(resumed?.toolCallCount).toBe(0);
    // NOT run-scoped, so the resume leaves both standing: `prompt` is the
    // brief the child was spawned on and `workspace` is where it runs, and the
    // resume patch names neither — both still hold the values run 1's
    // `createChild` wrote. A `workspace: undefined` added to that patch reddens
    // the second line.
    expect(resumed?.prompt).toBe('survey the repo');
    expect(resumed?.workspace).toBe(afterRunOne?.workspace);

    await coordinator.waitChild(subagentId);
    const afterRunTwo = conversations.get(subagentId)?.subagent;
    // PER-RUN, not cumulative — which is what the terminal write has always
    // done (`finalizeTerminal`'s `this.persist`, `child-handle.ts:630`),
    // because `resumeChild` builds a FRESH handle whose counters start at
    // zero.
    expect(afterRunTwo?.toolCallCount).toBe(1);
    expect(afterRunTwo?.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(afterRunTwo?.startedAt).toBe('2026-09-09T12:14:00.000Z');
  });

  function createRow(
    driver: ReturnType<typeof makeDriver>,
    childId: string,
    parentId: string,
  ): void {
    driver.createChild({
      id: childId,
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: parentId,
      parentTurnId: 'parent-turn-1',
      title: 'survey repo',
      subagent: {
        type: 'general-purpose',
        status: 'running',
        description: 'survey repo',
        prompt: 'go',
        model: 'test/model',
        background: false,
        depth: 1,
        startedAt: '2026-09-05T00:00:00.000Z',
        toolCallCount: 0,
        oneShot: false,
      },
    });
  }
});

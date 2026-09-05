import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
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
    });
  });

  afterEach(async () => {
    await hub.stop();
    conversations.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeDriver(hubRef: () => ResumableChatHub | undefined = () => hub) {
    const driver = createChildTurnDriver({ conversations, hub: hubRef });
    driver.attachObserver();
    return driver;
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

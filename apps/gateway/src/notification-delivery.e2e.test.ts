import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import { SwarmCoordinator } from '@dash/swarm';
import { type AgentChatCoordinator, createAgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';
import type { ConversationAutoTitleService } from './conversation-auto-title.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { type WorkerBackend, createFakeChildDriver } from './fake-child-driver.js';
import { createNotificationDriver } from './notification-driver.js';
import { type ResumableChatHub, createResumableChatHub } from './resumable-chat-hub.js';
import { isSubagentsEnabled } from './subagent-config.js';

/**
 * END-TO-END for design §7.3 completion notifications.
 *
 * Nothing on the delivery path is mocked: a REAL `SqliteConversationService`
 * (so `pending_notifications` is a real table with the real 100-row cap), a
 * REAL `AgentRegistry`, the REAL `AgentChatCoordinator` merge wrapper, and the
 * REAL `ResumableChatHub` — whose `acceptTurn` is what actually decides idle vs
 * busy and which throws the typed `conversation_busy` the driver has to
 * translate. Only the LLM is fake: the orchestrator's `AgentBackend` and the
 * child transport are scripted.
 *
 * The wiring below mirrors `index.ts` exactly (late-bound `hubRef`, the
 * `onFinish` observer that drains), because a divergence there is precisely the
 * class of bug this file exists to catch.
 */

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const AGENT_NAME = 'orchestrator';
const USAGE = { inputTokens: 1, outputTokens: 1 };

/** What the scripted orchestrator does for one turn on one conversation. */
type TurnScript = (ctx: { conversationId: string }) => AsyncGenerator<AgentEvent>;

describe('completion notifications, end to end', () => {
  let tmpDir: string;
  let conversations: SqliteConversationService;
  let registry: AgentRegistry;
  let coordinator: SwarmCoordinator;
  let agents: AgentChatCoordinator;
  let hub: ResumableChatHub;
  let agentId: string;
  let parentId: string;
  /** Scripts the orchestrator backend pops, in turn order. */
  let scripts: TurnScript[];
  /** Resolves the backend that the next spawned child will run. */
  let childBackends: WorkerBackend[];
  /** Everything the notification driver warned about. */
  let warnings: string[];

  const autoTitle: ConversationAutoTitleService = { schedule: () => {}, flush: async () => {} };

  const orchestrator: AgentBackend = {
    name: 'scripted-orchestrator',
    start: async () => {},
    stop: async () => {},
    abort: () => {},
    async *run(state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
      const script = scripts.shift();
      const conversationId = state.conversationId ?? '';
      if (!script) {
        yield { type: 'response', content: 'nothing to do', usage: USAGE };
        return;
      }
      yield* script({ conversationId });
    },
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'notification-e2e-'));
    scripts = [];
    childBackends = [];
    warnings = [];
    conversations = new SqliteConversationService({ dataDir: tmpDir });
    registry = new AgentRegistry();
    agentId = registry.register({
      name: AGENT_NAME,
      model: 'test/model',
      systemPrompt: 'orchestrate',
    }).id;

    const hubRef: { current?: ResumableChatHub } = {};
    const childDriver = createFakeChildDriver(async () => {
      const backend = childBackends.shift();
      if (!backend) throw new Error('no child backend scripted');
      return backend;
    });

    coordinator = new SwarmCoordinator({
      childDriver,
      notifications: createNotificationDriver({
        conversations,
        hub: () => hubRef.current,
        agentRegistry: registry,
        warn: (message) => warnings.push(message),
      }),
    });

    agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => orchestrator,
      swarm: {
        coordinator,
        isEnabled: (id) => {
          const entry = registry.get(id);
          return !!entry && isSubagentsEnabled(entry.config);
        },
      },
    });

    hub = createResumableChatHub({ conversations, agents, autoTitle });
    hubRef.current = hub;
    // Ruling 3: the parent's finishTurn is what drains a queue that piled up
    // while it was busy. Same registration index.ts performs.
    hub.addObserver({
      onEvent() {},
      onFinish(turn) {
        void coordinator.deliverPending(turn.agentId, turn.conversationId).catch(() => {});
      },
    });

    parentId = conversations.create({
      agentId,
      agentName: AGENT_NAME,
      requestId: 'req-parent',
    }).id;
  });

  afterEach(async () => {
    await hub.stop();
    await agents.stop();
    conversations.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** A child that reports `report` once `release` resolves. */
  function scriptChild(report: string, release: Promise<void>): void {
    childBackends.push({
      async *chat(): AsyncGenerator<AgentEvent> {
        await release;
        yield { type: 'response', content: report, usage: USAGE };
      },
      abort() {},
      async stop() {},
    });
  }

  /** Runs one user turn on the parent and resolves when the hub finishes it. */
  async function runUserTurn(turnId: string, text: string): Promise<void> {
    const done = deferred();
    const off = hub.addObserver({
      onEvent() {},
      onFinish(turn) {
        if (turn.turnId === turnId) done.resolve();
      },
    });
    hub.start(
      {
        type: 'message',
        id: turnId,
        agentId,
        channelId: 'direct',
        conversationId: parentId,
        text,
        resumable: true,
      },
      { send: () => true },
    );
    await done.promise;
    off();
  }

  /** Resolves once a turn with `origin: 'notification'` count reaches `n`. */
  async function waitForNotificationTurns(n: number): Promise<void> {
    await vi.waitFor(() => {
      expect(notificationMessages()).toHaveLength(n);
    });
    // The turn is accepted at that point; let it run to completion.
    await vi.waitFor(() => {
      expect(conversations.get(parentId)?.activeTurnId ?? null).toBeNull();
    });
  }

  function notificationMessages() {
    return conversations
      .listMessages({ conversationId: parentId, limit: 100 })
      .items.filter((message) => message.origin === 'notification' && message.role === 'user');
  }

  function textOf(message: { content: unknown }): string {
    const content = message.content as { text?: string };
    return content.text ?? '';
  }

  /** The persisted event log for one turn, oldest first. */
  function persistedEvents(turnId: string): AgentEvent[] {
    return conversations.eventLog
      .readSince(agentId, parentId, 0)
      .filter((entry) => entry.msgId === turnId && entry.payload.type === 'event')
      .map((entry) => (entry.payload as { type: 'event'; event: AgentEvent }).event);
  }

  it('delivers to an IDLE parent as a server-initiated turn, subagent_finished FIRST', async () => {
    const release = deferred();
    scriptChild('the scout found three TODOs', release.promise);

    // Turn 1: the orchestrator spawns a BACKGROUND child and returns without
    // waiting for it — the case that has nothing to deliver the report on.
    scripts.push(async function* ({ conversationId }) {
      coordinator.spawnWorker(agentId, conversationId, {
        role: 'scout',
        brief: 'survey the repo',
        background: true,
        name: 'scout',
      });
      yield { type: 'response', content: 'spawned', usage: USAGE };
    });
    // Turn 2 is the NOTIFICATION turn the coordinator starts.
    scripts.push(async function* () {
      yield { type: 'response', content: 'noted the scout report', usage: USAGE };
    });

    await runUserTurn('turn-1', 'go survey');
    expect(notificationMessages()).toHaveLength(0);

    // The parent is now idle. The child finishes.
    release.resolve();
    await waitForNotificationTurns(1);

    const [notification] = notificationMessages();
    const text = textOf(notification);
    expect(text).toContain('[SYSTEM NOTIFICATION - NOT USER INPUT]');
    expect(text).toContain('<task-notification>');
    expect(text).toContain('<agent-name>scout</agent-name>');
    expect(text).toContain('the scout found three TODOs');

    // Ruling 5, on the PERSISTED log rather than the live stream: the parent's
    // record of the turn has the child's terminal event before the
    // orchestrator's own output.
    const events = persistedEvents(notification.turnId);
    const finishedAt = events.findIndex((event) => event.type === 'subagent_finished');
    const responseAt = events.findIndex((event) => event.type === 'response');
    expect(finishedAt).toBeGreaterThanOrEqual(0);
    expect(responseAt).toBeGreaterThanOrEqual(0);
    expect(finishedAt).toBeLessThan(responseAt);
  });

  it('coalesces into ONE turn, in creation order, when the parent is BUSY', async () => {
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const holdTurn = deferred();
    scriptChild('first report', releaseFirst.promise);
    scriptChild('second report', releaseSecond.promise);

    // One long parent turn that spawns both children and stays open.
    scripts.push(async function* ({ conversationId }) {
      coordinator.spawnWorker(agentId, conversationId, {
        role: 'a',
        brief: 'first',
        background: true,
        name: 'first',
      });
      coordinator.spawnWorker(agentId, conversationId, {
        role: 'b',
        brief: 'second',
        background: true,
        name: 'second',
      });
      await holdTurn.promise;
      yield { type: 'response', content: 'done holding', usage: USAGE };
    });
    scripts.push(async function* () {
      yield { type: 'response', content: 'noted both', usage: USAGE };
    });

    const turnDone = deferred();
    hub.addObserver({
      onEvent() {},
      onFinish(turn) {
        if (turn.turnId === 'turn-busy') turnDone.resolve();
      },
    });
    hub.start(
      {
        type: 'message',
        id: 'turn-busy',
        agentId,
        channelId: 'direct',
        conversationId: parentId,
        text: 'go',
        resumable: true,
      },
      { send: () => true },
    );

    // Both children finish WHILE the parent holds its turn lease. Each eager
    // delivery hits `conversation_busy`; the rows must stay queued.
    releaseFirst.resolve();
    await vi.waitFor(() => {
      expect(conversations.peekNotifications(parentId)).toHaveLength(1);
    });
    releaseSecond.resolve();
    await vi.waitFor(() => {
      expect(conversations.peekNotifications(parentId)).toHaveLength(2);
    });
    expect(notificationMessages()).toHaveLength(0);
    // A busy parent is the EXPECTED, common path — not a failure. If the hub's
    // typed `conversation_busy` reached the coordinator untranslated it would
    // fall through to the unclassified branch and warn here.
    expect(warnings).toEqual([]);

    holdTurn.resolve();
    await turnDone.promise;
    await waitForNotificationTurns(1);

    // ONE turn, not two, carrying both blocks in creation order (ruling 4).
    const messages = notificationMessages();
    expect(messages).toHaveLength(1);
    const text = textOf(messages[0]);
    expect(text.match(/<task-notification>/g)).toHaveLength(2);
    expect(text.indexOf('<agent-name>first</agent-name>')).toBeLessThan(
      text.indexOf('<agent-name>second</agent-name>'),
    );
    expect(conversations.peekNotifications(parentId)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('keeps delivering: a SECOND notification reaches the same conversation', async () => {
    // Regression for the in-flight guard that was added on the way in and
    // cleared only on the empty/busy returns, so the first delivered
    // notification in a conversation was also the last.
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    scriptChild('first report', releaseFirst.promise);
    scriptChild('second report', releaseSecond.promise);

    scripts.push(async function* ({ conversationId }) {
      coordinator.spawnWorker(agentId, conversationId, {
        role: 'a',
        brief: 'first',
        background: true,
        name: 'first',
      });
      yield { type: 'response', content: 'spawned first', usage: USAGE };
    });
    scripts.push(async function* () {
      yield { type: 'response', content: 'noted first', usage: USAGE };
    });
    scripts.push(async function* ({ conversationId }) {
      coordinator.spawnWorker(agentId, conversationId, {
        role: 'b',
        brief: 'second',
        background: true,
        name: 'second',
      });
      yield { type: 'response', content: 'spawned second', usage: USAGE };
    });
    scripts.push(async function* () {
      yield { type: 'response', content: 'noted second', usage: USAGE };
    });

    await runUserTurn('turn-1', 'go');
    releaseFirst.resolve();
    await waitForNotificationTurns(1);

    await runUserTurn('turn-2', 'go again');
    releaseSecond.resolve();
    await waitForNotificationTurns(2);

    const texts = notificationMessages().map(textOf);
    expect(texts[0]).toContain('<agent-name>first</agent-name>');
    expect(texts[1]).toContain('<agent-name>second</agent-name>');
    expect(conversations.peekNotifications(parentId)).toEqual([]);
  });

  it('drops the queue with a warning when the agent has been DISABLED', async () => {
    // Ruling 8, bounded failure. The gate reads the registry entry's `status`
    // plus `isSubagentsEnabled(config)` — the canonical predicate. A gate on
    // `agent.config.enabled`, a field GatewayAgentConfig does not have, never
    // fires, and the notification turn is started on a disabled agent instead.
    const release = deferred();
    scriptChild('orphan report', release.promise);
    scripts.push(async function* ({ conversationId }) {
      coordinator.spawnWorker(agentId, conversationId, {
        role: 'a',
        brief: 'first',
        background: true,
        name: 'first',
      });
      yield { type: 'response', content: 'spawned', usage: USAGE };
    });

    await runUserTurn('turn-1', 'go');
    registry.disable(agentId);
    release.resolve();

    await vi.waitFor(() => {
      expect(warnings.join('\n')).toMatch(/not accepting sub-agent turns/);
    });
    expect(notificationMessages()).toHaveLength(0);
    // Dropped, not retried forever.
    expect(conversations.peekNotifications(parentId)).toEqual([]);
  });
});

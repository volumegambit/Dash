import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
import { SwarmCoordinator } from '@dash/swarm';
import type { AgentChatCoordinator, ChatRequest } from './agent-chat-coordinator.js';
import type { AgentRegistry, GatewayAgentConfig, RegisteredAgent } from './agent-registry.js';
import { createChildTurnDriver } from './child-turn-driver.js';
import type { ConversationAutoTitleService } from './conversation-auto-title.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { recoverGatewayTurns } from './gateway-recovery.js';
import { createNotificationDriver } from './notification-driver.js';
import { type ResumableChatHub, createResumableChatHub } from './resumable-chat-hub.js';
import { reconstructChildSpec } from './subagent-resume.js';
import { INTERRUPTED_CHILD_REPORT } from './swarm-log-recovery.js';

/**
 * END-TO-END for design §7.5 (restart) — the claim the whole task turns on:
 * "an interrupted child is resumable with `send_message`".
 *
 * Nothing on the path is mocked except the model. One real
 * `SqliteConversationService` over one real data dir, the REAL
 * `ResumableChatHub`, the REAL `createChildTurnDriver` (so the child is a real
 * conversation and its grant is really persisted), and the real
 * `reconstructChildSpec`. The "restart" is a hard one: the first process's
 * service is closed with a child mid-turn and a SECOND service is opened over
 * the same directory, exactly as a SIGKILL leaves things.
 */

const AGENT_ID = 'agent-01';
const AGENT_NAME = 'Helper';
const PARENT_TURN = 'parent-turn-1';

const autoTitle: ConversationAutoTitleService = { schedule: () => {}, flush: async () => {} };

const agentConfig: GatewayAgentConfig = {
  name: AGENT_NAME,
  model: 'test/model',
  systemPrompt: 'orchestrate',
  tools: ['read', 'bash'],
};

/** The one registered agent, as `createNotificationDriver` reads the registry. */
const agentRegistry = {
  get: (id: string) =>
    id === AGENT_ID
      ? ({
          id,
          name: AGENT_NAME,
          config: agentConfig,
          status: 'registered',
          registeredAt: '2026-09-06T00:00:00.000Z',
        } as RegisteredAgent)
      : undefined,
} as unknown as AgentRegistry;

type Script = () => AsyncGenerator<AgentEvent>;

/**
 * A chat coordinator that replays whatever script the test has installed for
 * CHILD conversations right now. Keyed on the ref rather than the child id
 * because `spawnChild` mints the id and starts the turn synchronously — there
 * is no moment in between to register a script by id.
 */
function makeAgents(childScript: { current: Script }): AgentChatCoordinator {
  return {
    chat: (request: ChatRequest) =>
      request.conversationId.startsWith('sub_')
        ? childScript.current()
        : (async function* () {
            yield {
              type: 'response',
              content: 'nothing to do',
              usage: { inputTokens: 1, outputTokens: 1 },
            } as AgentEvent;
          })(),
    answerQuestion: async () => {},
    cancel: () => true,
    sealSteering: async () => [],
  } as unknown as AgentChatCoordinator;
}

/** Let queued microtasks and the hub's synchronous turn start settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('a child interrupted by a gateway restart', { timeout: 20_000 }, () => {
  let dataDir: string;
  let childScript: { current: Script };
  let hubs: ResumableChatHub[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'subagent-restart-'));
    childScript = {
      current: async function* () {
        yield {
          type: 'response',
          content: 'unset',
          usage: { inputTokens: 1, outputTokens: 1 },
        } as AgentEvent;
      },
    };
    hubs = [];
  });

  afterEach(async () => {
    for (const hub of hubs) await hub.stop().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });

  /** One gateway "process" over the shared data dir. */
  function boot(conversations: SqliteConversationService): {
    coordinator: SwarmCoordinator;
    hub: ResumableChatHub;
  } {
    const hubRef: { current?: ResumableChatHub } = {};
    const childDriver = createChildTurnDriver({
      conversations,
      hub: () => hubRef.current,
      warn: () => {},
    });
    const coordinator: SwarmCoordinator = new SwarmCoordinator({
      childDriver,
      reconstructChildSpec: (subagentId) =>
        reconstructChildSpec(subagentId, {
          conversations,
          liveSpec: (id) => coordinator.liveChildSpec(id),
          agentConfig: () => agentConfig,
          agentMcpTools: () => [],
        }),
      notifications: createNotificationDriver({
        conversations,
        hub: () => hubRef.current,
        agentRegistry,
        warn: () => {},
      }),
    });
    const hub = createResumableChatHub({
      conversations,
      agents: makeAgents(childScript),
      autoTitle,
      isAgentEnabled: () => true,
    });
    hubRef.current = hub;
    // index.ts:1058 does exactly this once the hub exists; without it the
    // driver never sees a child turn's events or its finish.
    childDriver.attachObserver();
    hubs.push(hub);
    return { coordinator, hub };
  }

  it('is marked interrupted, wakes its parent, and can then be resumed', async () => {
    // ---------- process 1: a child is spawned and never finishes ----------
    const first = new SqliteConversationService({ dataDir });
    const { coordinator } = boot(first);

    const parent = first.create({
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      requestId: 'req-1',
    });
    first.acceptTurn({
      agentId: AGENT_ID,
      conversationId: parent.id,
      turnId: PARENT_TURN,
      text: 'delegate this',
    });
    const attachment = coordinator.attach({
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      conversationId: parent.id,
      orchestratorModel: 'test/model',
      messageId: PARENT_TURN,
    });

    // The merge wrapper's job, done by hand: everything the run emits lands on
    // the PARENT's log. That is what leaves the dangling `subagent_started`
    // recovery has to find.
    const emitted: AgentEvent[] = [];
    void (async () => {
      for (;;) {
        const next = await attachment.channel.take();
        if (next.done) return;
        emitted.push(next.value);
        try {
          first.appendTurnEvent(parent.id, PARENT_TURN, next.value);
        } catch {
          // The service is closed by the simulated crash below.
        }
      }
    })();

    // The child hangs forever: this process is going to die under it.
    const neverEnds = new Promise<never>(() => {});
    childScript.current = async function* () {
      yield { type: 'text_delta', text: 'looking…' } as AgentEvent;
      await neverEnds;
    };
    const { subagentId } = coordinator.spawnChild(
      {
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        conversationId: parent.id,
        turnId: PARENT_TURN,
        depth: 0,
        workspace: dataDir,
      },
      { role: 'scout', brief: 'survey the repo', name: 'scout', tools: ['read'] },
    );
    await flush();

    expect(emitted.some((event) => event.type === 'subagent_started')).toBe(true);
    expect(first.get(subagentId)?.subagent?.status).toBe('running');
    expect(first.get(subagentId)?.status).toBe('running');
    // The grant the resume will be rebuilt from was persisted at spawn.
    expect(first.getSubagentGrant(subagentId)?.tools).toContain('read');

    // ---------- SIGKILL ----------
    // No graceful shutdown: nothing gets to write a terminal state.
    first.close();

    // ---------- process 2: boot recovery ----------
    const second = new SqliteConversationService({ dataDir });
    const recovery = recoverGatewayTurns({
      eventLog: second.eventLog,
      conversations: second,
    });

    // §7.5: the child is interrupted, not left running forever.
    expect(recovery.conversations.subagentsInterrupted).toBeGreaterThanOrEqual(1);
    expect(second.get(subagentId)?.subagent?.status).toBe('interrupted');

    // §7.4: the parent's tail terminalizes instead of spinning.
    const parentTail = second.eventLog.readSince(AGENT_ID, parent.id, 0);
    const finish = parentTail.find(
      (entry) => entry.payload.type === 'event' && entry.payload.event.type === 'subagent_finished',
    );
    expect(finish?.payload).toMatchObject({
      type: 'event',
      event: { subagentId, status: 'interrupted', report: INTERRUPTED_CHILD_REPORT },
    });
    // …and the generic pass's terminal marker is the LAST entry, so the next
    // boot does not see this conversation as interrupted all over again.
    expect(parentTail.at(-1)?.payload.type).toBe('error');

    // §7.3/§7.5: exactly one notification is waiting for the parent, whichever
    // of the two recovery halves produced it.
    const queued = second.peekNotifications(parent.id);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toMatchObject({ subagentId, status: 'interrupted' });

    // ---------- the queued notification is DELIVERED once the hub is up ----------
    const { coordinator: resumed } = boot(second);
    await expect(resumed.deliverPending(AGENT_ID, parent.id)).resolves.toBe('started');
    expect(second.peekNotifications(parent.id)).toEqual([]);
    const parentMessages = second.listMessages({ conversationId: parent.id, limit: 20 }).items;
    const woken = parentMessages.find((message) => message.origin === 'notification');
    expect(woken?.content).toMatchObject({
      type: 'user',
      text: expect.stringContaining('<status>interrupted</status>'),
    });

    // ---------- the point: it can be resumed ----------
    let resumedText = '';
    childScript.current = async function* () {
      resumedText = 'ran again';
      yield {
        type: 'response',
        content: 'picked the work back up',
        usage: { inputTokens: 2, outputTokens: 3 },
      } as AgentEvent;
    };

    const result = resumed.sendToChild(parent.id, subagentId, 'carry on where you left off');
    expect(result).toMatchObject({ ok: true, mode: 'resumed' });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (second.get(subagentId)?.subagent?.status === 'done') break;
      await flush();
    }

    expect(resumedText).toBe('ran again');
    // The resume is a new turn on the child's OWN conversation: the transcript
    // survived the restart rather than being replaced.
    const messages = second.listMessages({ conversationId: subagentId, limit: 20 }).items;
    expect(messages.length).toBeGreaterThanOrEqual(4);
    expect(messages.map((message) => message.role)).toContain('assistant');
    expect(second.get(subagentId)?.subagent?.status).toBe('done');

    // Deliberately NOT finalizing the first process's attachment: that process
    // is dead, its database is closed, and touching it here would be testing a
    // shutdown path this scenario says never ran.
    second.close();
  });
});

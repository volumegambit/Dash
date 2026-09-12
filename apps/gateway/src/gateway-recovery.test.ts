import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationService } from './conversation-service.js';
import type { EventLogStore } from './event-log-store.js';
import { orchestrateGatewayStartup, recoverGatewayTurns } from './gateway-recovery.js';

describe('recoverGatewayTurns', () => {
  it('repairs canonical subagent tails before v2 recovery and child notifications', () => {
    // The order is load-bearing. The tail pass appends `subagent_finished`, so
    // it MUST precede the generic pass that writes the terminal marker — an
    // event after that marker leaves the log non-terminal and the conversation
    // comes back "interrupted" on every boot. The child pass MUST follow it,
    // because the generic pass is what sets `subagent_status = 'interrupted'`.
    const calls: string[] = [];
    const eventLog = {
      listInterrupted: vi.fn(() => {
        calls.push('tails');
        return [];
      }),
    } as unknown as EventLogStore;
    const conversations = {
      listActiveRunsForRecovery: vi.fn(() => []),
      recoverV2State: vi.fn(() => {
        calls.push('conversation');
        return {
          conversationsInterrupted: 2,
          terminalsAppended: 1,
          subagentsInterrupted: 3,
          eligibleConversationIds: ['conversation-a'],
        };
      }),
      listInterruptedSubagents: vi.fn(() => {
        calls.push('children');
        return [];
      }),
      updateSubagent: vi.fn(),
      enqueueNotification: vi.fn(),
      peekNotifications: vi.fn(() => []),
      get: vi.fn(() => null),
    } as unknown as ConversationService;

    expect(recoverGatewayTurns({ eventLog, conversations })).toEqual({
      swarm: {
        conversationsRepaired: 0,
        childrenTerminalized: 0,
        notificationsQueued: 0,
        pendingDelivery: [],
        canonicalConversationsRepaired: [],
        failedCanonicalConversationIds: [],
      },
      subagents: {
        conversationsRepaired: 0,
        childrenTerminalized: 0,
        notificationsQueued: 0,
        pendingDelivery: [],
        canonicalConversationsRepaired: [],
        failedCanonicalConversationIds: [],
      },
      conversations: {
        conversationsInterrupted: 2,
        terminalsAppended: 1,
        subagentsInterrupted: 3,
        eligibleConversationIds: ['conversation-a'],
      },
      notifiedChildren: { childrenNotified: 0, pendingDelivery: [] },
      pendingDelivery: [],
      excludedConversationIds: [],
    });
    expect(calls).toEqual(['tails', 'conversation', 'children']);
    expect(conversations.recoverV2State).toHaveBeenCalledWith({
      excludeConversationIds: new Set(),
    });
  });

  it('quarantines a failed canonical repair, expands deletion-agent exclusions, and continues', () => {
    const eventLog = {
      listInterrupted: vi.fn(() => [
        {
          agentId: 'agent-delete',
          conversationId: 'conversation-bad',
          lastMsgId: 'legacy-message',
          lastTerminalSeq: 0,
        },
      ]),
      readSince: vi.fn(() => [
        {
          seq: 1,
          agentId: 'agent-delete',
          conversationId: 'conversation-bad',
          msgId: 'outer-bad',
          timestamp: '2026-09-06T00:00:00.000Z',
          payload: {
            type: 'event',
            event: {
              type: 'subagent_started',
              subagentId: 'subagent-bad',
              subagentType: 'general-purpose',
              description: 'research',
              prompt: 'research',
              model: 'test',
              background: true,
              depth: 1,
              startedAt: '2026-09-06T00:00:00.000Z',
            },
          },
        },
      ]),
      append: vi.fn(),
    } as unknown as EventLogStore;
    const active = [
      {
        agentId: 'agent-delete',
        conversationId: 'conversation-bad',
        runId: 'outer-bad',
      },
      {
        agentId: 'agent-delete',
        conversationId: 'conversation-sibling',
        runId: 'outer-sibling',
      },
      { agentId: 'agent-ok', conversationId: 'conversation-ok', runId: 'outer-ok' },
    ];
    const conversations = {
      listActiveRunsForRecovery: vi.fn(() => active),
      appendCurrentRunEvent: vi.fn(() => null),
      recoverV2State: vi.fn(() => ({
        conversationsInterrupted: 1,
        terminalsAppended: 1,
        eligibleConversationIds: ['conversation-ok'],
      })),
      listInterruptedSubagents: vi.fn(() => []),
      updateSubagent: vi.fn(),
      enqueueNotification: vi.fn(),
      peekNotifications: vi.fn(() => []),
      get: vi.fn(() => null),
    } as unknown as ConversationService;
    const admission = {
      markRecoveryRequired: vi.fn(),
      beginRecoveryCleanup: vi.fn(),
      clearRecoveryRequired: vi.fn(),
    };

    const result = recoverGatewayTurns({
      eventLog,
      conversations,
      admission: admission as never,
      isDeletionMarked: (agentId) => agentId === 'agent-delete',
    });

    expect(result.excludedConversationIds).toEqual(['conversation-bad', 'conversation-sibling']);
    expect(admission.markRecoveryRequired).toHaveBeenCalledWith('agent-delete', 'conversation-bad');
    expect(conversations.recoverV2State).toHaveBeenCalledWith({
      excludeConversationIds: new Set(['conversation-bad', 'conversation-sibling']),
    });
    expect(eventLog.append).not.toHaveBeenCalled();
  });

  it('continues unrelated canonical recovery and clears quarantine only after a successful retry terminal', () => {
    const active = [
      { agentId: 'agent-delete', conversationId: 'conversation-bad', runId: 'outer-bad' },
      {
        agentId: 'agent-delete',
        conversationId: 'conversation-sibling',
        runId: 'outer-sibling',
      },
      { agentId: 'agent-ok', conversationId: 'conversation-ok', runId: 'outer-ok' },
    ];
    const eventLog = {
      listInterrupted: vi.fn(() =>
        active.map((run) => ({
          agentId: run.agentId,
          conversationId: run.conversationId,
          lastMsgId: run.runId,
          lastTerminalSeq: 0,
        })),
      ),
      readSince: vi.fn((agentId: string, conversationId: string) => [
        {
          seq: 1,
          agentId,
          conversationId,
          msgId: active.find((run) => run.conversationId === conversationId)?.runId,
          segmentTurnId: 'segment-current',
          timestamp: '2026-09-06T00:00:00.000Z',
          payload: {
            type: 'event',
            event: {
              type: 'subagent_started',
              subagentId: `subagent-${conversationId}`,
              subagentType: 'general-purpose',
              description: 'research',
              prompt: 'research',
              model: 'test',
              background: true,
              depth: 1,
              startedAt: '2026-09-06T00:00:00.000Z',
            },
          },
        },
      ]),
      append: vi.fn(),
    } as unknown as EventLogStore;
    let badRepairFails = true;
    const order: string[] = [];
    const conversations = {
      listActiveRunsForRecovery: vi.fn(() => active),
      appendCurrentRunEvent: vi.fn(
        (_agentId: string, conversationId: string, _outerRunId: string) => {
          order.push(`repair:${conversationId}`);
          if (conversationId === 'conversation-bad' && badRepairFails) return null;
          return { v1Seq: 2, v2Frame: { v2Seq: 2 } };
        },
      ),
      recoverV2State: vi.fn(
        ({ excludeConversationIds }: { excludeConversationIds: Set<string> }) => {
          order.push(`recover:${[...excludeConversationIds].sort().join(',')}`);
          return {
            conversationsInterrupted: active.length - excludeConversationIds.size,
            terminalsAppended: active.length - excludeConversationIds.size,
            eligibleConversationIds: active
              .map((run) => run.conversationId)
              .filter((id) => !excludeConversationIds.has(id)),
          };
        },
      ),
      listInterruptedSubagents: vi.fn(() => []),
      updateSubagent: vi.fn(),
      enqueueNotification: vi.fn(),
      peekNotifications: vi.fn(() => []),
      get: vi.fn(() => null),
    } as unknown as ConversationService;
    const cleanupToken = { kind: 'recovery' };
    const admission = {
      markRecoveryRequired: vi.fn(() => order.push('quarantine:bad')),
      beginRecoveryCleanup: vi.fn(() => cleanupToken),
      clearRecoveryRequired: vi.fn(() => order.push('clear:bad')),
    };

    const first = recoverGatewayTurns({
      eventLog,
      conversations,
      admission: admission as never,
      isDeletionMarked: (agentId) => agentId === 'agent-delete',
    });
    expect(first.excludedConversationIds).toEqual(['conversation-bad', 'conversation-sibling']);
    expect(first.conversations.eligibleConversationIds).toEqual(['conversation-ok']);
    expect(admission.clearRecoveryRequired).not.toHaveBeenCalled();
    expect(eventLog.append).not.toHaveBeenCalled();

    order.length = 0;
    badRepairFails = false;
    const second = recoverGatewayTurns({
      eventLog,
      conversations,
      admission: admission as never,
      isDeletionMarked: (agentId) => agentId === 'agent-delete',
    });
    expect(second.excludedConversationIds).toEqual([]);
    expect(second.conversations.eligibleConversationIds).toEqual([
      'conversation-bad',
      'conversation-sibling',
      'conversation-ok',
    ]);
    expect(admission.beginRecoveryCleanup).toHaveBeenCalledWith('agent-delete', 'conversation-bad');
    expect(admission.clearRecoveryRequired).toHaveBeenCalledWith(
      'agent-delete',
      'conversation-bad',
      cleanupToken,
    );
    expect(order.indexOf('recover:')).toBeLessThan(order.indexOf('clear:bad'));
  });
});

describe('orchestrateGatewayStartup', () => {
  it('completes storage, runtime construction, deletion, and queue handoff before ingress', async () => {
    const calls: string[] = [];
    const step = (name: string) => async () => {
      calls.push(name);
    };

    await orchestrateGatewayStartup({
      restoreDeletionFences: step('agentRegistry.restoreDeletionFences'),
      repairCanonicalWorkers: step('swarmRecovery.repairCanonicalWorkers'),
      recoverV2State: step('conversationService.recoverV2State'),
      pauseDisabledAgentQueues: step('conversationService.pauseDisabledAgentQueues'),
      createAgentCoordinator: step('createAgentCoordinator'),
      createResumableChatHub: step('createResumableChatHub'),
      resumePendingAgentDeletions: step('resumePendingAgentDeletions'),
      resumeRecoveredQueues: step('resumableChatHub.resumeRecoveredQueues'),
      startRestoredChannelAdapters: step('startRestoredChannelAdapters'),
      startListeners: step('startListeners'),
      startRelayDial: step('startRelayDial'),
      ready: step('Server ready'),
    });

    expect(calls).toEqual([
      'agentRegistry.restoreDeletionFences',
      'swarmRecovery.repairCanonicalWorkers',
      'conversationService.recoverV2State',
      'conversationService.pauseDisabledAgentQueues',
      'createAgentCoordinator',
      'createResumableChatHub',
      'resumePendingAgentDeletions',
      'resumableChatHub.resumeRecoveredQueues',
      'startRestoredChannelAdapters',
      'startListeners',
      'startRelayDial',
      'Server ready',
    ]);
  });

  it('fails closed before every ingress path when a recovery phase rejects', async () => {
    const started: string[] = [];
    await expect(
      orchestrateGatewayStartup({
        restoreDeletionFences: async () => {},
        repairCanonicalWorkers: async () => {},
        recoverV2State: async () => {},
        pauseDisabledAgentQueues: async () => {
          throw new Error('pause failed');
        },
        createAgentCoordinator: async () => {},
        createResumableChatHub: async () => {},
        resumePendingAgentDeletions: async () => {},
        resumeRecoveredQueues: async () => {},
        startRestoredChannelAdapters: async () => {
          started.push('adapter');
        },
        startListeners: async () => {
          started.push('listener');
        },
        startRelayDial: async () => {
          started.push('relay');
        },
        ready: async () => {
          started.push('ready');
        },
      }),
    ).rejects.toThrow('pause failed');
    expect(started).toEqual([]);
  });

  it('awaits every startup phase before entering the next one', async () => {
    const names = [
      'restoreDeletionFences',
      'repairCanonicalWorkers',
      'recoverV2State',
      'pauseDisabledAgentQueues',
      'createAgentCoordinator',
      'createResumableChatHub',
      'resumePendingAgentDeletions',
      'resumeRecoveredQueues',
      'startRestoredChannelAdapters',
      'startListeners',
      'startRelayDial',
      'ready',
    ] as const;
    const calls: string[] = [];
    const gates = names.map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    });
    const steps = Object.fromEntries(
      names.map((name, index) => [
        name,
        async () => {
          calls.push(name);
          await gates[index].promise;
        },
      ]),
    ) as unknown as Parameters<typeof orchestrateGatewayStartup>[0];

    const startup = orchestrateGatewayStartup(steps);
    for (const [index, name] of names.entries()) {
      await vi.waitFor(() => expect(calls).toEqual(names.slice(0, index + 1)));
      expect(calls).not.toContain(names[index + 1]);
      gates[index].resolve();
    }
    await startup;
  });

  it.each([
    'restoreDeletionFences',
    'repairCanonicalWorkers',
    'recoverV2State',
    'pauseDisabledAgentQueues',
    'createAgentCoordinator',
    'createResumableChatHub',
    'resumePendingAgentDeletions',
    'resumeRecoveredQueues',
  ] as const)('keeps all ingress closed when %s fails', async (failedPhase) => {
    const ingress: string[] = [];
    const phase = (name: string) => async () => {
      if (name === failedPhase) throw new Error(`${name} failed`);
    };

    await expect(
      orchestrateGatewayStartup({
        restoreDeletionFences: phase('restoreDeletionFences'),
        repairCanonicalWorkers: phase('repairCanonicalWorkers'),
        recoverV2State: phase('recoverV2State'),
        pauseDisabledAgentQueues: phase('pauseDisabledAgentQueues'),
        createAgentCoordinator: phase('createAgentCoordinator'),
        createResumableChatHub: phase('createResumableChatHub'),
        resumePendingAgentDeletions: phase('resumePendingAgentDeletions'),
        resumeRecoveredQueues: phase('resumeRecoveredQueues'),
        startRestoredChannelAdapters: async () => {
          ingress.push('adapter');
        },
        startListeners: async () => {
          ingress.push('listener');
        },
        startRelayDial: async () => {
          ingress.push('relay');
        },
        ready: async () => {
          ingress.push('ready');
        },
      }),
    ).rejects.toThrow(`${failedPhase} failed`);
    expect(ingress).toEqual([]);
  });

  it('does not start a synchronously delivering restored adapter before both handoffs settle', async () => {
    let deletionResumed = false;
    let queuesHandedOff = false;
    let releaseDeletion!: () => void;
    let releaseQueues!: () => void;
    const deletionGate = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    const queueGate = new Promise<void>((resolve) => {
      releaseQueues = resolve;
    });
    const startRestoredChannelAdapters = vi.fn(() => {
      expect(deletionResumed).toBe(true);
      expect(queuesHandedOff).toBe(true);
    });
    const noop = async () => {};
    const startup = orchestrateGatewayStartup({
      restoreDeletionFences: noop,
      repairCanonicalWorkers: noop,
      recoverV2State: noop,
      pauseDisabledAgentQueues: noop,
      createAgentCoordinator: noop,
      createResumableChatHub: noop,
      resumePendingAgentDeletions: async () => {
        await deletionGate;
        deletionResumed = true;
      },
      resumeRecoveredQueues: async () => {
        await queueGate;
        queuesHandedOff = true;
      },
      startRestoredChannelAdapters,
      startListeners: noop,
      startRelayDial: noop,
      ready: noop,
    });

    await Promise.resolve();
    expect(startRestoredChannelAdapters).not.toHaveBeenCalled();
    releaseDeletion();
    await vi.waitFor(() => expect(deletionResumed).toBe(true));
    expect(startRestoredChannelAdapters).not.toHaveBeenCalled();
    releaseQueues();
    await startup;
    expect(startRestoredChannelAdapters).toHaveBeenCalledOnce();
  });
});

describe('gateway conversation composition', () => {
  it('shares one database, auto-title service, and hub across recovery, management, and chat', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    expect(source.match(/new SqliteConversationService/g)).toHaveLength(1);
    expect(source).toContain('const eventLogStore = conversationService.eventLog');
    expect(source.match(/createConversationAutoTitleService\(/g)).toHaveLength(1);
    expect(source.match(/createResumableChatHub\(/g)).toHaveLength(1);
    expect(source).toContain('autoTitle: conversationAutoTitle');
    expect(source).toContain('recoverGatewayTurns({');
    expect(source).toContain('orchestrateGatewayStartup({');
    expect(source).not.toContain('recoverInterruptedSwarmTurns({');
    expect(source).not.toContain('restoreFinalizedRun');
    // §7.5: what recovery queued has to be DELIVERED once the hub exists.
    expect(source).toContain('recoveredNotificationTargets');
    expect(source).toContain('deliverPending(target.agentId, target.conversationId)');
    // A throw inside recovery must not take boot down (the child sweep is one
    // unguarded UPDATE inside its transaction).
    expect(source).toContain('[recovery] boot recovery failed');

    const managementMount = source.slice(
      source.indexOf('createGatewayManagementApp({'),
      source.indexOf('// Wrap the management app'),
    );
    const chatMount = source.slice(
      source.indexOf('mountChatWs('),
      source.indexOf('if (verboseWs)'),
    );
    const autoTitle = source.slice(
      source.indexOf('createConversationAutoTitleService({'),
      source.indexOf('const resumableChatHub'),
    );
    expect(autoTitle).toContain('registry.get(agentId)');
    expect(autoTitle).toContain('credentialStore.readProviderApiKeys()');
    expect(autoTitle).toContain('pluginModelCatalog: wiringState.pluginModelCatalog');
    expect(autoTitle).toContain('...(entry.config.providerApiKeys ?? {})');
    expect(managementMount).toContain('conversationService');
    expect(managementMount).toContain('resumableChatHub');
    expect(chatMount).toContain('resumableChatHub');
    expect(source).toContain('return resumableChatHub.resumeRecoveredQueues(eligible);');
  });

  it('constructs lifecycle coordination before listeners or relay startup', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const shutdown = source.indexOf('createGatewayShutdownCoordinator({');
    const startup = source.indexOf('orchestrateGatewayStartup({');
    const firstServe = source.indexOf('serve({');
    const relay = source.indexOf('relayClient.start(');

    expect(shutdown).toBeGreaterThanOrEqual(0);
    expect(startup).toBeGreaterThan(shutdown);
    expect(firstServe).toBeGreaterThan(startup);
    expect(relay).toBeGreaterThan(startup);
  });

  it('suspends the shared hub before MCP/workers and closes conversation storage once', () => {
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const shutdownSource = readFileSync(new URL('./shutdown.ts', import.meta.url), 'utf8');
    const steps = [
      "safeStep('agents.interruptAll'",
      "safeStep('resumableChatHub.suspend'",
      "safeStep('admission.drainPrior'",
      "safeStep('mcpManager.stop'",
      "safeStep('swarmCoordinator.stop'",
      "safeStep('agents.stop'",
      "safeStep('gateway.stop'",
      "safeStep('projectsDb.close'",
      "safeStep('conversationService.close'",
    ];
    const positions = steps.map((step) => shutdownSource.indexOf(step));

    expect(indexSource).toContain('createGatewayShutdownCoordinator({');
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(indexSource).not.toContain('conversationService.close()');
    expect(shutdownSource.match(/options\.conversationService\.close\(\)/g)).toHaveLength(1);
    expect(shutdownSource).not.toContain('eventLogStore.close()');
  });

  it('enables payload logging only through the explicit verbose flag', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    expect(source).toContain('const verboseWs = flags.verbose === true;');
    expect(source).not.toContain("process.env.NODE_ENV !== 'production'");
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STOP_ORDER } from './app/lifecycle.js';
import type { ConversationService } from './conversation-service.js';
import type { EventLogStore } from './event-log-store.js';
import { recoverGatewayTurns } from './gateway-recovery.js';

describe('recoverGatewayTurns', () => {
  it('orders the three passes: parent tails, generic leases, then child notifications', () => {
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
      recoverInterruptedTurns: vi.fn(() => {
        calls.push('conversations');
        return { conversationsInterrupted: 2, terminalsAppended: 1, subagentsInterrupted: 3 };
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
      subagents: {
        conversationsRepaired: 0,
        childrenTerminalized: 0,
        notificationsQueued: 0,
        pendingDelivery: [],
      },
      conversations: {
        conversationsInterrupted: 2,
        terminalsAppended: 1,
        subagentsInterrupted: 3,
      },
      notifiedChildren: { childrenNotified: 0, pendingDelivery: [] },
      pendingDelivery: [],
    });
    expect(calls).toEqual(['tails', 'conversations', 'children']);
  });
});

describe('gateway conversation composition', () => {
  it('shares one database, auto-title service, execution owner, and hub across gateway entrypoints', () => {
    const source = readFileSync(new URL('./app/bootstrap.ts', import.meta.url), 'utf8');
    const application = readFileSync(new URL('./app/application.ts', import.meta.url), 'utf8');

    expect(source.match(/new SqliteConversationService/g)).toHaveLength(1);
    expect(source).toContain('const eventLogStore = conversationService.eventLog');
    expect(source.match(/createConversationAutoTitleService\(/g)).toHaveLength(1);
    expect(source.match(/createExecutionCoordinator\(/g)).toHaveLength(1);
    expect(source.match(/createResumableChatHub\(/g)).toHaveLength(1);
    expect(source.indexOf('recoverGatewayTurns({')).toBeLessThan(
      source.indexOf('createExecutionCoordinator({'),
    );
    expect(source.indexOf('createExecutionCoordinator({')).toBeLessThan(
      source.indexOf('createResumableChatHub({'),
    );
    expect(source.indexOf('createResumableChatHub({')).toBeLessThan(
      source.indexOf('await listenGatewaySurface('),
    );
    expect(source).toContain('autoTitle: conversationAutoTitle');
    expect(source).toContain('recoverGatewayTurns({');
    expect(source).not.toContain('recoverInterruptedSwarmTurns({');
    expect(source).not.toContain('restoreFinalizedRun');
    // §7.5: what recovery queued has to be DELIVERED once execution exists.
    expect(source).toContain('recoveredNotificationTargets');
    expect(source).toContain('deliverPending(target.agentId, target.conversationId)');
    // A throw inside recovery must not take boot down (the child sweep is one
    // unguarded UPDATE inside its transaction).
    expect(source).toContain('[recovery] boot recovery failed');

    const applicationMount = source.slice(
      source.indexOf('const application = createGatewayApplication({'),
      source.indexOf('const managementServer ='),
    );
    const autoTitle = source.slice(
      source.indexOf('createConversationAutoTitleService({'),
      source.indexOf('const execution ='),
    );
    expect(autoTitle).toContain('registry.get(agentId)');
    expect(autoTitle).toContain('credentialStore.readProviderApiKeys()');
    expect(autoTitle).toContain('pluginModelCatalog: wiringState.pluginModelCatalog');
    expect(autoTitle).toContain('...(entry.config.providerApiKeys ?? {})');
    expect(applicationMount).toContain('conversationService,');
    expect(applicationMount).toContain('execution,');
    expect(applicationMount).toContain('hub: resumableChatHub');
    expect(application).toContain('const deps = options.management');
    expect(application).toContain('createGatewayManagementApp(deps)');
    expect(application).toContain('execution: deps.execution');
    expect(application).toContain('resumableChatHub: options.hub');
    expect(application).toContain('eventLogStore: deps.conversationService.eventLog');
    expect(application).toContain('conversations: deps.conversationService');
    expect(application).toContain('chat: createChatSurface(new Hono())');
    expect(application).toContain('lan: createChatSurface(createLanMobileApp(managementApp))');
  });

  it('stops execution, disposes the hub, and flushes titles before workers and storage', () => {
    const source = readFileSync(new URL('./app/bootstrap.ts', import.meta.url), 'utf8');
    // Bootstrap registers resources as it acquires them. Their explicit
    // priorities, not source positions, determine which dependencies survive
    // until execution and maintenance work settle.
    const registrations = new Map(
      [...source.matchAll(/lifecycle\.add\(\s*'([^']+)',\s*STOP_ORDER\.(\w+),([\s\S]*?)\);/g)].map(
        ([, name, priority, close]) => [name, { priority, close }],
      ),
    );
    const steps: Array<[string, keyof typeof STOP_ORDER, string]> = [
      ['execution.stop', 'execution', 'execution.stop()'],
      ['hub.dispose', 'subscriptions', 'resumableChatHub.dispose()'],
      ['title.flush', 'maintenance', "safeFlush('conversationAutoTitle.flush'"],
      ['swarm.stop', 'swarm', 'swarmCoordinator.stop()'],
      ['agents.stop', 'runtimes', 'agents.stop()'],
      ['channels.stop', 'channels', 'gateway.stop()'],
      ['managementServer.close', 'listeners', 'managementServer.close'],
      ['channelServer.close', 'listeners', 'channelServer.close'],
      ['lanServer.close', 'listeners', 'lanServer.close'],
      ['conversations.close', 'databases', 'conversationService.close()'],
      ['projects.close', 'databases', 'projectsDb.db.close()'],
    ];
    for (const [name, priority, close] of steps) {
      expect(registrations.get(name)?.priority, name).toBe(priority);
      expect(registrations.get(name)?.close, name).toContain(close);
    }
    const priorities = steps.map(([, priority]) => STOP_ORDER[priority]);
    expect(priorities).toEqual([...priorities].sort((left, right) => left - right));
    expect(STOP_ORDER.listeners).toBeLessThan(STOP_ORDER.databases);
    expect(source.match(/conversationService\.close\(\)/g)).toHaveLength(1);
    expect(source).not.toContain('eventLogStore.close()');
  });

  it('enables payload logging only through the explicit verbose flag', () => {
    const source = readFileSync(new URL('./app/bootstrap.ts', import.meta.url), 'utf8');
    const application = readFileSync(new URL('./app/application.ts', import.meta.url), 'utf8');

    expect(source).toContain('verboseWs: flags.verbose === true');
    expect(application).toContain('verbose: options.verboseWs === true');
    expect(source).not.toContain("process.env.NODE_ENV !== 'production'");
    expect(application).not.toContain("process.env.NODE_ENV !== 'production'");
  });
});

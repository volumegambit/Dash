import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
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
  it('shares one database, auto-title service, and hub across recovery, management, and chat', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    expect(source.match(/new SqliteConversationService/g)).toHaveLength(1);
    expect(source).toContain('const eventLogStore = conversationService.eventLog');
    expect(source.match(/createConversationAutoTitleService\(/g)).toHaveLength(1);
    expect(source.match(/createResumableChatHub\(/g)).toHaveLength(1);
    expect(source).toContain('autoTitle: conversationAutoTitle');
    expect(source).toContain('recoverGatewayTurns({');
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
  });

  it('stops the shared hub and titles before workers and closes conversation storage once', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const steps = [
      "safeStep('resumableChatHub.stop'",
      "safeFlush('conversationAutoTitle.flush'",
      "safeStep('swarmCoordinator.stop'",
      "safeStep('agents.stop'",
      "safeStep('gateway.stop'",
      "safeStep('managementServer.close'",
      "safeStep('channelServer.close'",
      "safeStep('conversationService.close'",
      "safeStep('projectsDb.close'",
    ];
    const positions = steps.map((step) => source.indexOf(step));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(source.match(/conversationService\.close\(\)/g)).toHaveLength(1);
    expect(source).not.toContain('eventLogStore.close()');
  });

  it('enables payload logging only through the explicit verbose flag', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    expect(source).toContain('const verboseWs = flags.verbose === true;');
    expect(source).not.toContain("process.env.NODE_ENV !== 'production'");
  });
});

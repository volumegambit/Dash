import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationService } from './conversation-service.js';
import type { EventLogStore } from './event-log-store.js';
import { recoverGatewayTurns } from './gateway-recovery.js';

describe('recoverGatewayTurns', () => {
  it('repairs swarm state before canonical conversation leases and returns both results', () => {
    const calls: string[] = [];
    const eventLog = {
      listInterrupted: vi.fn(() => {
        calls.push('swarm');
        return [];
      }),
    } as unknown as EventLogStore;
    const conversations = {
      recoverInterruptedTurns: vi.fn(() => {
        calls.push('conversation');
        return { conversationsInterrupted: 2, terminalsAppended: 1 };
      }),
    } as Pick<ConversationService, 'recoverInterruptedTurns'>;

    expect(recoverGatewayTurns({ eventLog, conversations })).toEqual({
      swarm: { conversationsRepaired: 0, workersCancelled: 0 },
      conversations: { conversationsInterrupted: 2, terminalsAppended: 1 },
    });
    expect(calls).toEqual(['swarm', 'conversation']);
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
      "safeStep('conversationAutoTitle.flush'",
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

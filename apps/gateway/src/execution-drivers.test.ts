import { AgentRegistry } from './agent-registry.js';
import { createChildTurnDriver } from './child-turn-driver.js';
import type { ConversationService } from './conversation-service.js';
import { createNotificationDriver } from './notification-driver.js';

describe('server-initiated execution without a transport', () => {
  it('starts, observes, and cancels a child using the execution owner directly', async () => {
    const dispose = vi.fn();
    const execution = {
      startSystemTurn: vi.fn(() => ({ turnId: 'child-turn' })),
      addObserver: vi.fn(() => dispose),
      cancel: vi.fn(async () => {}),
    };
    const conversations = {
      get: vi.fn(() => ({ activeTurnId: 'child-turn' })),
    } as unknown as ConversationService;
    const driver = createChildTurnDriver({ conversations, execution: () => execution });

    expect(
      driver.startTurn({
        agentId: 'agent',
        conversationId: 'child',
        text: 'work',
        origin: 'parent',
      }),
    ).toEqual({
      turnId: 'child-turn',
    });
    expect(execution.startSystemTurn).toHaveBeenCalledWith({
      agentId: 'agent',
      conversationId: 'child',
      text: 'work',
      origin: 'parent',
    });
    expect(driver.attachObserver()).toBe(dispose);
    await driver.cancelTurn('agent', 'child');
    expect(execution.cancel).toHaveBeenCalledWith('child-turn');
  });

  it('starts durable notifications through execution without constructing a chat hub', () => {
    const execution = { startSystemTurn: vi.fn(() => ({ turnId: 'notification-turn' })) };
    const registry = new AgentRegistry();
    const agent = registry.register({ name: 'Helper', model: 'test/model', systemPrompt: '' });
    const driver = createNotificationDriver({
      conversations: {} as ConversationService,
      execution: () => execution,
      agentRegistry: registry,
      warn: vi.fn(),
    });

    expect(
      driver.startNotificationTurn(agent.id, 'parent', 'finished', 'notification-turn'),
    ).toEqual({
      turnId: 'notification-turn',
    });
    expect(execution.startSystemTurn).toHaveBeenCalledWith({
      agentId: agent.id,
      conversationId: 'parent',
      text: 'finished',
      origin: 'notification',
      turnId: 'notification-turn',
    });
  });
});

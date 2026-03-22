import { EventBus } from './event-bus.js';
import type { GatewayEvent } from './event-bus.js';

describe('EventBus', () => {
  it('delivers events to subscribers', () => {
    const bus = new EventBus();
    const received: GatewayEvent[] = [];
    bus.subscribe((e) => received.push(e));
    bus.emit({ type: 'agent:config-changed', agent: 'Dev', fields: ['model'] });
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('agent:config-changed');
  });

  it('supports multiple subscribers', () => {
    const bus = new EventBus();
    let count = 0;
    bus.subscribe(() => count++);
    bus.subscribe(() => count++);
    bus.emit({ type: 'mcp:server-added', server: 'fal-ai' });
    expect(count).toBe(2);
  });

  it('unsubscribe stops delivery', () => {
    const bus = new EventBus();
    let count = 0;
    const unsub = bus.subscribe(() => count++);
    bus.emit({ type: 'mcp:server-added', server: 'test' });
    unsub();
    bus.emit({ type: 'mcp:server-added', server: 'test2' });
    expect(count).toBe(1);
  });

  it('does not break on subscriber error', () => {
    const bus = new EventBus();
    const received: GatewayEvent[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => received.push(e));
    bus.emit({ type: 'mcp:server-removed', server: 'test' });
    expect(received).toHaveLength(1);
  });
});

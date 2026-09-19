import { createGatewayLifecycle } from './lifecycle.js';

describe('Gateway resource lifecycle', () => {
  it('closes admission before dependencies and shares one stop completion', async () => {
    const order: string[] = [];
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifecycle = createGatewayLifecycle();
    lifecycle.add('database', 100, () => {
      order.push('database');
    });
    lifecycle.add('execution', 0, async () => {
      order.push('execution');
      await settled;
    });
    lifecycle.add('runtime', 50, () => {
      order.push('runtime');
    });
    const first = lifecycle.stop();
    const second = lifecycle.stop();
    expect(second).toBe(first);
    expect(order).toEqual(['execution']);
    release();
    await first;
    expect(order).toEqual(['execution', 'runtime', 'database']);
    await lifecycle.stop();
    expect(order).toHaveLength(3);
  });

  it('cleans resources registered before a failed startup even if one close fails', async () => {
    const close = vi.fn();
    const lifecycle = createGatewayLifecycle();
    lifecycle.add('failing resource', 10, () => {
      throw new Error('cleanup failure');
    });
    lifecycle.add('database', 100, close);
    await lifecycle.stop();
    expect(close).toHaveBeenCalledOnce();
    expect(() => lifecycle.add('late', 50, close)).toThrow('stopping');
  });
});

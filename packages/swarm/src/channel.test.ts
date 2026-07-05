import { AsyncChannel } from './channel.js';

describe('AsyncChannel', () => {
  it('delivers pushed values in order to sequential takes', async () => {
    const ch = new AsyncChannel<number>();
    ch.push(1);
    ch.push(2);
    expect((await ch.take()).value).toBe(1);
    expect((await ch.take()).value).toBe(2);
  });
  it('resolves a pending take on push', async () => {
    const ch = new AsyncChannel<number>();
    const p = ch.take();
    ch.push(7);
    expect((await p).value).toBe(7);
  });
  it('drains buffer before reporting done after close', async () => {
    const ch = new AsyncChannel<number>();
    ch.push(1);
    ch.close();
    expect(await ch.take()).toEqual({ done: false, value: 1 });
    expect((await ch.take()).done).toBe(true);
  });
  it('resolves all pending takes as done on close', async () => {
    const ch = new AsyncChannel<number>();
    const a = ch.take();
    const b = ch.take();
    ch.close();
    expect((await a).done).toBe(true);
    expect((await b).done).toBe(true);
  });
  it('push after close is a no-op', async () => {
    const ch = new AsyncChannel<number>();
    ch.close();
    ch.push(1);
    expect((await ch.take()).done).toBe(true);
  });
});

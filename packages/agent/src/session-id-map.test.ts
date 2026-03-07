import { describe, expect, it, vi } from 'vitest';
import { SessionIdMap } from './session-id-map.js';

const makeClient = (sessions: { id: string; title: string }[]) => ({
  session: {
    list: vi.fn().mockResolvedValue({ data: sessions }),
    create: vi.fn().mockImplementation(({ title }: { title: string }) =>
      Promise.resolve({ data: { id: 'new-uuid', title } })
    ),
  },
});

describe('SessionIdMap', () => {
  it('rebuilds map from existing sessions on init', async () => {
    const client = makeClient([
      { id: 'uuid-1', title: 'telegram:conv-1' },
      { id: 'uuid-2', title: 'telegram:conv-2' },
    ]);

    const map = new SessionIdMap();
    await map.init(client as any);

    expect(await map.getOrCreate('telegram', 'conv-1', client as any)).toBe('uuid-1');
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it('creates new session when key not found', async () => {
    const client = makeClient([]);
    const map = new SessionIdMap();
    await map.init(client as any);

    const id = await map.getOrCreate('telegram', 'new-conv', client as any);

    expect(id).toBe('new-uuid');
    expect(client.session.create).toHaveBeenCalledWith({ title: 'telegram:new-conv' });
  });

  it('ignores sessions without a colon in title', async () => {
    const client = makeClient([{ id: 'uuid-x', title: 'untitled' }]);
    const map = new SessionIdMap();
    await map.init(client as any);

    await map.getOrCreate('ch', 'conv', client as any);
    expect(client.session.create).toHaveBeenCalled();
  });

  it('returns same UUID on repeated calls for same key', async () => {
    const client = makeClient([]);
    const map = new SessionIdMap();
    await map.init(client as any);

    const id1 = await map.getOrCreate('slack', 'thread-1', client as any);
    const id2 = await map.getOrCreate('slack', 'thread-1', client as any);

    expect(id1).toBe(id2);
    expect(client.session.create).toHaveBeenCalledTimes(1);
  });
});

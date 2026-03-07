import { describe, expect, it, vi } from 'vitest';
import type { SessionClient } from './session-id-map.js';
import { SessionIdMap } from './session-id-map.js';

function makeClient(sessions: { id: string; title: string }[]): SessionClient {
  return {
    session: {
      list: vi.fn().mockResolvedValue({ data: sessions }),
      create: vi
        .fn()
        .mockImplementation(({ title }: { title: string }) =>
          Promise.resolve({ data: { id: 'new-uuid', title } }),
        ),
    },
  };
}

describe('SessionIdMap', () => {
  it('rebuilds map from existing sessions on init', async () => {
    const client = makeClient([
      { id: 'uuid-1', title: 'telegram:conv-1' },
      { id: 'uuid-2', title: 'telegram:conv-2' },
    ]);

    const map = new SessionIdMap();
    await map.init(client);

    expect(await map.getOrCreate('telegram', 'conv-1', client)).toBe('uuid-1');
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it('creates new session when key not found', async () => {
    const client = makeClient([]);
    const map = new SessionIdMap();
    await map.init(client);

    const id = await map.getOrCreate('telegram', 'new-conv', client);

    expect(id).toBe('new-uuid');
    expect(client.session.create).toHaveBeenCalledWith({ title: 'telegram:new-conv' });
  });

  it('ignores sessions without a colon in title', async () => {
    const client = makeClient([{ id: 'uuid-x', title: 'untitled' }]);
    const map = new SessionIdMap();
    await map.init(client);

    await map.getOrCreate('ch', 'conv', client);
    expect(client.session.create).toHaveBeenCalled();
  });

  it('returns same UUID on repeated calls for same key', async () => {
    let callCount = 0;
    const client: SessionClient = {
      session: {
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockImplementation(({ title }: { title: string }) => {
          callCount++;
          return Promise.resolve({ data: { id: `uuid-${callCount}`, title } });
        }),
      },
    };
    const map = new SessionIdMap();
    await map.init(client);

    const id1 = await map.getOrCreate('slack', 'thread-1', client);
    const id2 = await map.getOrCreate('slack', 'thread-1', client);

    expect(id1).toBe(id2);
    expect(client.session.create).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent getOrCreate calls for same key', async () => {
    let callCount = 0;
    const client: SessionClient = {
      session: {
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockImplementation(({ title }: { title: string }) => {
          callCount++;
          return Promise.resolve({ data: { id: `uuid-${callCount}`, title } });
        }),
      },
    };
    const map = new SessionIdMap();
    await map.init(client);

    // Both calls fired without awaiting
    const [id1, id2] = await Promise.all([
      map.getOrCreate('slack', 'parallel-1', client),
      map.getOrCreate('slack', 'parallel-1', client),
    ]);

    expect(id1).toBe(id2);
    expect(client.session.create).toHaveBeenCalledTimes(1);
  });
});

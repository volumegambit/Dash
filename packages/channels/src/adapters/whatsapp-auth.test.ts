import { describe, expect, it, vi } from 'vitest';
import type { SecretStore } from '../types.js';
import { makeBaileysAuthState } from './whatsapp-auth.js';

function makeStore(initial: Record<string, string> = {}): SecretStore {
  const data = { ...initial };
  return {
    get: vi.fn(async (key: string) => data[key] ?? null),
    set: vi.fn(async (key: string, value: string) => {
      data[key] = value;
    }),
    delete: vi.fn(async (key: string) => {
      delete data[key];
    }),
    list: vi.fn(async () => Object.keys(data)),
  };
}

describe('makeBaileysAuthState', () => {
  it('initialises with fresh creds when store is empty', async () => {
    const store = makeStore();
    const { state } = await makeBaileysAuthState(store, 'wa:');
    expect(state.creds.me).toBeUndefined(); // fresh creds have no me
    expect(state.creds.noiseKey).toBeDefined();
  });

  it('loads existing creds from store', async () => {
    const fakeCredsJson = JSON.stringify({ noiseKey: { public: 'abc', private: 'xyz' } });
    const store = makeStore({ 'wa:creds': fakeCredsJson });
    const { state } = await makeBaileysAuthState(store, 'wa:');
    expect(state.creds.noiseKey).toEqual({ public: 'abc', private: 'xyz' });
  });

  it('saveCreds writes serialized creds to store', async () => {
    const store = makeStore();
    const { state, saveCreds } = await makeBaileysAuthState(store, 'wa:');
    (state.creds as Record<string, unknown>).me = { id: '1234@s.whatsapp.net', name: 'Test' };
    await saveCreds();
    expect(store.set).toHaveBeenCalledWith(
      'wa:creds',
      expect.stringContaining('1234@s.whatsapp.net'),
    );
  });

  it('keys.set stores each key value under namespaced key', async () => {
    const store = makeStore();
    const { state } = await makeBaileysAuthState(store, 'wa:');
    await state.keys.set({
      'pre-key': {
        '1': { public: new Uint8Array([1]), private: new Uint8Array([2]) },
        '2': { public: new Uint8Array([3]), private: new Uint8Array([4]) },
      },
    });
    expect(store.set).toHaveBeenCalledWith(
      'wa:key:pre-key-1',
      JSON.stringify({ public: new Uint8Array([1]), private: new Uint8Array([2]) }),
    );
    expect(store.set).toHaveBeenCalledWith(
      'wa:key:pre-key-2',
      JSON.stringify({ public: new Uint8Array([3]), private: new Uint8Array([4]) }),
    );
  });

  it('keys.set deletes null values from store', async () => {
    const store = makeStore({ 'wa:key:pre-key-1': '{"keyId":1}' });
    const { state } = await makeBaileysAuthState(store, 'wa:');
    await state.keys.set({ 'pre-key': { '1': null } });
    expect(store.delete).toHaveBeenCalledWith('wa:key:pre-key-1');
  });

  it('keys.get retrieves values by type and ids', async () => {
    const store = makeStore({ 'wa:key:pre-key-5': '{"keyId":5}' });
    const { state } = await makeBaileysAuthState(store, 'wa:');
    const result = await state.keys.get('pre-key', ['5', '6']);
    expect(result['5']).toEqual({ keyId: 5 });
    expect(result['6']).toBeNull();
  });

  it('serializes concurrent saveCreds calls sequentially', async () => {
    const store = makeStore();
    const { state, saveCreds } = await makeBaileysAuthState(store, 'wa:');
    const calls: number[] = [];
    const origSet = store.set as ReturnType<typeof vi.fn>;
    origSet.mockImplementation(async (key: string, value: string) => {
      await new Promise((r) => setTimeout(r, 10));
      calls.push(Date.now());
    });
    await Promise.all([saveCreds(), saveCreds(), saveCreds()]);
    // All 3 should have run (sequential, not dropped)
    expect(calls).toHaveLength(3);
  });
});

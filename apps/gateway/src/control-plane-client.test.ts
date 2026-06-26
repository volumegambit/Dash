import { createControlPlaneClient } from './control-plane-client.js';

const identity = { signCpAssertion: (gw: string) => `assert-for-${gw}` };

describe('control-plane-client', () => {
  it('POSTs a cp-dial-token assertion and returns the minted token', async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | undefined;
    let seenMethod: string | undefined;
    const client = createControlPlaneClient({
      controlPlaneUrl: 'https://cp.example.com',
      gatewayId: 'gw-1',
      identity,
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenAuth = init?.headers?.authorization;
        seenMethod = init?.method;
        return { ok: true, status: 200, json: async () => ({ dialToken: 'fresh.tok' }) };
      },
    });
    const tok = await client.refreshDialToken();
    expect(tok).toBe('fresh.tok');
    expect(seenUrl).toBe('https://cp.example.com/gw/dial-token');
    expect(seenMethod).toBe('POST');
    expect(seenAuth).toBe('Bearer assert-for-gw-1');
  });

  it('strips a trailing slash from the control plane URL', async () => {
    let seenUrl: string | undefined;
    const client = createControlPlaneClient({
      controlPlaneUrl: 'https://cp.example.com/',
      gatewayId: 'gw-1',
      identity,
      fetchImpl: async (url) => {
        seenUrl = url;
        return { ok: true, status: 200, json: async () => ({ dialToken: 't' }) };
      },
    });
    await client.refreshDialToken();
    expect(seenUrl).toBe('https://cp.example.com/gw/dial-token');
  });

  it('throws on a non-2xx response', async () => {
    const client = createControlPlaneClient({
      controlPlaneUrl: 'https://cp.example.com',
      gatewayId: 'gw-1',
      identity,
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    });
    await expect(client.refreshDialToken()).rejects.toThrow(/401/);
  });

  it('throws on an empty or malformed token body', async () => {
    const client = createControlPlaneClient({
      controlPlaneUrl: 'https://cp.example.com',
      gatewayId: 'gw-1',
      identity,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ dialToken: '' }) }),
    });
    await expect(client.refreshDialToken()).rejects.toThrow(/dialToken/);
  });
});

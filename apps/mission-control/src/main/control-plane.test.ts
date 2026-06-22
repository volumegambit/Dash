import { describe, expect, it, vi } from 'vitest';
import { makeWorkosSeams, readControlPlaneConfig } from './control-plane.js';

const config = {
  baseUrl: 'https://cp.test',
  workosClientId: 'client_123',
  workosApiKey: 'sk_test',
};

describe('readControlPlaneConfig', () => {
  it('reads values from the environment', () => {
    expect(
      readControlPlaneConfig({
        DASH_CONTROL_PLANE_URL: 'https://cp.example',
        DASH_WORKOS_CLIENT_ID: 'client_abc',
        DASH_WORKOS_API_KEY: 'sk_live',
      }),
    ).toEqual({
      baseUrl: 'https://cp.example',
      workosClientId: 'client_abc',
      workosApiKey: 'sk_live',
    });
  });

  it('falls back to a default base URL and empty WorkOS config when unset', () => {
    const cfg = readControlPlaneConfig({});
    expect(cfg.baseUrl).toMatch(/^https:\/\//);
    expect(cfg.workosClientId).toBe('');
    expect(cfg.workosApiKey).toBe('');
  });
});

describe('makeWorkosSeams', () => {
  it('builds an AuthKit authorize URL carrying the client id and decoded redirect', () => {
    const seams = makeWorkosSeams(config);
    // The session passes the redirect already URL-encoded; the seam decodes it
    // before handing it to WorkOS so it is not double-encoded.
    const url = new URL(seams.buildAuthUrl(encodeURIComponent('http://127.0.0.1:5123/callback')));
    expect(url.searchParams.get('client_id')).toBe('client_123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5123/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('exchanges a code via WorkOS and converts expiresIn (s) to an absolute expiry (ms)', async () => {
    const authenticateWithCode = vi.fn().mockResolvedValue({ accessToken: 'at-1', expiresIn: 600 });
    const loadWorkos = vi.fn().mockResolvedValue({ userManagement: { authenticateWithCode } });
    const seams = makeWorkosSeams(config, loadWorkos, () => 1_000_000);

    const result = await seams.exchangeCode('code-abc');
    expect(authenticateWithCode).toHaveBeenCalledWith({ clientId: 'client_123', code: 'code-abc' });
    expect(result).toEqual({ accessToken: 'at-1', expiresAt: 1_000_000 + 600 * 1000 });
  });

  it('defaults to a 1h lifetime when WorkOS omits expiresIn', async () => {
    const authenticateWithCode = vi.fn().mockResolvedValue({ accessToken: 'at-2' });
    const loadWorkos = vi.fn().mockResolvedValue({ userManagement: { authenticateWithCode } });
    const seams = makeWorkosSeams(config, loadWorkos, () => 0);

    const result = await seams.exchangeCode('code-xyz');
    expect(result).toEqual({ accessToken: 'at-2', expiresAt: 3600 * 1000 });
  });
});

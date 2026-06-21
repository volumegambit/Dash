import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeClaudeOAuth } from './claude-auth.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('completeClaudeOAuth', () => {
  it('returns access token, refresh token, and absolute expiry from the token response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'sk-ant-oat01-abc',
            refresh_token: 'refresh-xyz',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    const result = await completeClaudeOAuth('the-code', 'the-state', 'the-verifier');

    expect(result?.accessToken).toBe('sk-ant-oat01-abc');
    expect(result?.refreshToken).toBe('refresh-xyz');
    // expiresAt is an absolute epoch-ms timestamp ~ now + 3600s.
    expect(result?.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 5000);
    expect(result?.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 5000);
  });
});

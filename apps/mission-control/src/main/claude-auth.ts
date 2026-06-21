import { randomBytes } from 'node:crypto';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback';
const SCOPES = ['user:inference'];

interface PKCEPair {
  verifier: string;
  challenge: string;
}

async function generatePKCE(): Promise<PKCEPair> {
  const verifier = randomBytes(32).toString('base64url');
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  const challenge = Buffer.from(digest).toString('base64url');
  return { verifier, challenge };
}

function createState(): string {
  return randomBytes(16).toString('hex');
}

export interface ClaudeOAuthFlow {
  authorizeUrl: string;
  state: string;
  verifier: string;
}

export interface ClaudeTokenResult {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry as epoch milliseconds. */
  expiresAt: number;
}

/**
 * Prepare the Claude OAuth flow: generate PKCE + authorize URL.
 * Uses the manual redirect flow — the user is sent to platform.claude.com
 * which displays the authorization code for them to copy.
 */
export async function prepareClaudeOAuth(): Promise<ClaudeOAuthFlow> {
  const pkce = await generatePKCE();
  const state = createState();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URL);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);

  return {
    authorizeUrl: url.toString(),
    state,
    verifier: pkce.verifier,
  };
}

/**
 * Complete the Claude OAuth flow: exchange auth code for a token set.
 *
 * Returns the access token plus the refresh token and absolute expiry, so the
 * gateway can keep the short-lived access token fresh (see
 * OAuthRefreshCoordinator). The earlier version discarded refresh/expiry,
 * which left the token un-refreshable — it 401'd a few hours after login.
 */
export async function completeClaudeOAuth(
  rawCode: string,
  state: string,
  verifier: string,
): Promise<ClaudeTokenResult | null> {
  // The callback page may show the code with a '#state' suffix — strip it
  const code = rawCode.includes('#') ? rawCode.split('#')[0] : rawCode;

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URL,
      state,
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    console.error('[claude-auth] Token exchange failed:', tokenRes.status, text);
    throw new Error(`Token exchange failed (${tokenRes.status}): ${text}`);
  }
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tokenJson?.access_token || !tokenJson?.refresh_token) {
    throw new Error('Token response missing access_token or refresh_token');
  }

  // `expires_in` is seconds-from-now; store an absolute timestamp. Default to
  // 8h if the provider omits it (Anthropic OAuth access tokens are ~8h).
  const expiresInSec = typeof tokenJson.expires_in === 'number' ? tokenJson.expires_in : 8 * 3600;
  return {
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    expiresAt: Date.now() + expiresInSec * 1000,
  };
}

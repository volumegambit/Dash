import { randomBytes } from 'node:crypto';
import { type Server, createServer } from 'node:http';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
const CALLBACK_PORT = 1455;

export interface CodexTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

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

function buildAuthorizeUrl(pkce: PKCEPair, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'codex_cli_rs');
  return url.toString();
}

async function exchangeCode(code: string, verifier: string): Promise<CodexTokenResult | null> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    console.error(
      '[codex-auth] Token exchange failed:',
      res.status,
      await res.text().catch(() => ''),
    );
    return null;
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== 'number') {
    console.error('[codex-auth] Token response missing fields');
    return null;
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

export async function refreshCodexToken(refreshToken: string): Promise<CodexTokenResult | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) {
      console.error('[codex-auth] Token refresh failed:', res.status);
      return null;
    }
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== 'number') {
      return null;
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
  } catch (err) {
    console.error('[codex-auth] Token refresh error:', err);
    return null;
  }
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><title>Codex Login</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#fff">
<div style="text-align:center">
<h1 style="color:#22c55e">&#10003; Logged in</h1>
<p>You can close this tab and return to Mission Control.</p>
</div>
</body>
</html>`;

function startCallbackServer(state: string): Promise<{
  server: Server;
  waitForCode: () => Promise<string | null>;
}> {
  return new Promise((resolve) => {
    let receivedCode: string | null = null;
    let codeResolve: ((code: string | null) => void) | null = null;

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '', 'http://localhost');
        if (url.pathname !== '/auth/callback') {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        if (url.searchParams.get('state') !== state) {
          res.statusCode = 400;
          res.end('State mismatch');
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          res.statusCode = 400;
          res.end('Missing authorization code');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(SUCCESS_HTML);
        receivedCode = code;
        if (codeResolve) codeResolve(code);
      } catch {
        res.statusCode = 500;
        res.end('Internal error');
      }
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      resolve({
        server,
        waitForCode: () => {
          if (receivedCode) return Promise.resolve(receivedCode);
          return new Promise((res) => {
            codeResolve = res;
            // Timeout after 120 seconds
            setTimeout(() => res(null), 120_000);
          });
        },
      });
    });

    server.on('error', () => {
      resolve({
        server,
        waitForCode: () => Promise.resolve(null),
      });
    });
  });
}

/**
 * Run the full Codex OAuth flow:
 * 1. Generate PKCE + state
 * 2. Start local callback server
 * 3. Open browser to OpenAI auth
 * 4. Wait for callback
 * 5. Exchange code for tokens
 */
export async function startCodexOAuth(
  openBrowser: (url: string) => void,
): Promise<CodexTokenResult | null> {
  const pkce = await generatePKCE();
  const state = createState();
  const authorizeUrl = buildAuthorizeUrl(pkce, state);

  const { server, waitForCode } = await startCallbackServer(state);

  try {
    openBrowser(authorizeUrl);
    const code = await waitForCode();
    if (!code) return null;
    return await exchangeCode(code, pkce.verifier);
  } finally {
    server.close();
  }
}

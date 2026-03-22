import { createServer, type Server } from 'node:http';
import type { McpLogger } from './types.js';

export interface OAuthCallbackResult {
  code: string;
  state?: string;
}

export interface OAuthCallbackOptions {
  timeout?: number; // default 5 minutes (300_000ms)
  logger?: McpLogger;
}

export interface OAuthCallbackServer {
  /** The full callback URL (http://localhost:{port}/callback) */
  url: URL;
  /** Resolves when the callback is received with the auth code */
  waitForCallback: () => Promise<OAuthCallbackResult>;
  /** Manually close the server */
  close: () => void;
}

const DEFAULT_TIMEOUT = 300_000; // 5 minutes

const SUCCESS_HTML = `<!DOCTYPE html>
<html><body>
<h2>Authorization complete</h2>
<p>You can close this tab and return to Dash.</p>
</body></html>`;

export async function startOAuthCallbackServer(
  options?: OAuthCallbackOptions,
): Promise<OAuthCallbackServer> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const logger = options?.logger;

  let resolveCallback: (result: OAuthCallbackResult) => void;
  let rejectCallback: (err: Error) => void;

  const callbackPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  let closed = false;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing "code" parameter');
      return;
    }

    const state = url.searchParams.get('state') ?? undefined;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(SUCCESS_HTML);

    resolveCallback!({ code, state });

    // Auto-close after successful callback
    setTimeout(() => close(), 100);
  });

  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    server.closeAllConnections();
  };

  // Start listening on random port
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to get server address');
  }

  const callbackUrl = new URL(`http://localhost:${addr.port}/callback`);
  logger?.info(`[oauth] Callback server listening at ${callbackUrl}`);

  // Set up timeout
  const timeoutId = setTimeout(() => {
    rejectCallback!(new Error(`OAuth callback timed out after ${timeout}ms`));
    close();
  }, timeout);

  // Clear timeout when callback resolves
  const wrappedPromise = callbackPromise.then((result) => {
    clearTimeout(timeoutId);
    return result;
  });

  return {
    url: callbackUrl,
    waitForCallback: () => wrappedPromise,
    close: () => {
      clearTimeout(timeoutId);
      close();
    },
  };
}

import type { TokenSource } from './rest';

/**
 * Fetch-streaming SSE reader. A plain `EventSource` cannot send an
 * `Authorization` header, so the mobile v1 SSE endpoint is instead read via
 * `fetch` with a manual `text/event-stream` line-buffer parser.
 *
 * Only `data:` lines are interpreted — everything else (comments starting
 * with `:`, and other fields like `event:`/`id:`/`retry:`) is ignored per the
 * YAGNI note in the Task 9 brief: SSE event ids aren't needed because replay
 * position comes from the REST cursor, not SSE ids.
 *
 * `relayCredential` mirrors `MobileRestClient`: when the gateway is reached
 * through the hosted relay, every request must carry the per-pairing credential
 * or the relay rejects it with a 401 before the gateway ever sees it. Omitted
 * on a direct/LAN gateway connection, exactly as in `rest.ts`.
 */
export async function* readSse(
  url: string,
  tokens: TokenSource,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  relayCredential?: string,
): AsyncGenerator<unknown> {
  const token = await tokens.getToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (relayCredential) headers['x-dash-relay-credential'] = relayCredential;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal });
  } catch (err) {
    if (isAbortError(err)) return;
    throw err;
  }

  if (!response.body) return;

  const reader = response.body.getReader();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort);

  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  try {
    while (!signal.aborted) {
      let value: Uint8Array | undefined;
      let done: boolean | undefined;
      try {
        ({ value, done } = await reader.read());
      } catch (err) {
        // Real fetch rejects the pending read() with an AbortError when the
        // signal fires (rather than resolving `done: true`) — swallow that
        // and stop cleanly, but let genuine stream/network errors propagate.
        if (isAbortError(err) || signal.aborted) return;
        throw err;
      }
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        // SSE allows CRLF line endings; strip a trailing \r left by split('\n').
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line === '') {
          if (dataLines.length > 0) {
            const parsed = tryParse(dataLines.join('\n'));
            dataLines = [];
            if (parsed !== undefined) yield parsed;
          }
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // Comments (lines starting with ':') and other fields are ignored.
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function tryParse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    console.warn('readSse: dropping malformed data: payload', payload);
    return undefined;
  }
}

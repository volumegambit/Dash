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
 */
export async function* readSse(
  url: string,
  tokens: TokenSource,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): AsyncGenerator<unknown> {
  const token = await tokens.getToken();
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });

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
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
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

function tryParse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    console.warn('readSse: dropping malformed data: payload', payload);
    return undefined;
  }
}

import type { TokenSource } from './rest';
import { readSse } from './sse';

const TOKEN = 'test-token-abc';

function tokenSource(token = TOKEN): TokenSource {
  return { getToken: () => Promise.resolve(token) };
}

/** Builds a `ReadableStream<Uint8Array>` that emits `chunks` (already UTF-8 text) one at a time. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function fakeFetch(stream: ReadableStream<Uint8Array>) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(stream, { status: 200 });
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe('readSse', () => {
  it('parses a single complete data: line per chunk', async () => {
    const stream = streamOf(['data: {"a":1}\n\n', 'data: {"a":2}\n\n']);
    const fetchImpl = fakeFetch(stream);
    const controller = new AbortController();

    const events = await collect(
      readSse('https://relay.example/sse', tokenSource(), controller.signal, fetchImpl),
    );

    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('reassembles a data: line split mid-line across chunk boundaries', async () => {
    const stream = streamOf(['data: {"a"', ':1}\n\n', 'data: {"b":2}', '\n\n']);
    const fetchImpl = fakeFetch(stream);
    const controller = new AbortController();

    const events = await collect(
      readSse('https://relay.example/sse', tokenSource(), controller.signal, fetchImpl),
    );

    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('parses multiple events delivered in a single chunk', async () => {
    const stream = streamOf(['data: {"a":1}\n\ndata: {"a":2}\n\ndata: {"a":3}\n\n']);
    const fetchImpl = fakeFetch(stream);
    const controller = new AbortController();

    const events = await collect(
      readSse('https://relay.example/sse', tokenSource(), controller.signal, fetchImpl),
    );

    expect(events).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('ignores comment lines and non-data fields', async () => {
    const stream = streamOf([': keep-alive\n\n', 'event: message\ndata: {"a":1}\nid: 5\n\n']);
    const fetchImpl = fakeFetch(stream);
    const controller = new AbortController();

    const events = await collect(
      readSse('https://relay.example/sse', tokenSource(), controller.signal, fetchImpl),
    );

    expect(events).toEqual([{ a: 1 }]);
  });

  it('sends the bearer token as an Authorization header', async () => {
    const stream = streamOf(['data: {"a":1}\n\n']);
    const fetchImpl = fakeFetch(stream);
    const controller = new AbortController();

    await collect(
      readSse('https://relay.example/sse', tokenSource(), controller.signal, fetchImpl),
    );

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://relay.example/sse');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init?.signal).toBe(controller.signal);
  });

  it('stops cleanly without yielding further events once aborted (cancel() path)', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode('data: {"a":1}\n\n'));
        // Leave the stream open (no close()) to simulate an in-progress SSE connection.
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = fakeFetch(stream);

    const gen = readSse('https://relay.example/sse', tokenSource(), controller.signal, fetchImpl);
    const first = await gen.next();
    expect(first).toEqual({ value: { a: 1 }, done: false });

    controller.abort();
    const next = await gen.next();
    expect(next.done).toBe(true);
    expect(cancelled).toBe(true);
  });

  it('stops cleanly (does not throw) when a pending read() rejects with AbortError, matching real fetch', async () => {
    // Real fetch does NOT resolve a pending reader.read() with `done: true`
    // when its signal aborts — it *rejects* the read with a DOMException
    // named 'AbortError'. Simulate that faithfully via controller.error(),
    // which is what a real fetch implementation does internally on abort.
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let erroredWith: unknown;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode('data: {"a":1}\n\n'));
        controller.signal.addEventListener('abort', () => {
          const abortError = new DOMException('The operation was aborted.', 'AbortError');
          erroredWith = abortError;
          streamController.error(abortError);
        });
        // Leave the stream open (no close()) to simulate an in-progress SSE connection.
      },
    });
    const fetchImpl = fakeFetch(stream);

    const gen = readSse('https://relay.example/sse', tokenSource(), controller.signal, fetchImpl);
    const first = await gen.next();
    expect(first).toEqual({ value: { a: 1 }, done: false });

    controller.abort();
    await expect(gen.next()).resolves.toEqual({ value: undefined, done: true });
    expect(erroredWith).toBeInstanceOf(DOMException);
  });

  it('propagates a genuine (non-abort) stream error instead of swallowing it', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode('data: {"a":1}\n\n'));
      },
      pull(streamController) {
        streamController.error(new Error('network exploded'));
      },
    });
    const fetchImpl = fakeFetch(stream);

    const gen = readSse('https://relay.example/sse', tokenSource(), controller.signal, fetchImpl);
    const first = await gen.next();
    expect(first).toEqual({ value: { a: 1 }, done: false });

    await expect(gen.next()).rejects.toThrow('network exploded');
    expect(controller.signal.aborted).toBe(false);
  });

  it('parses a single CRLF-terminated data: event', async () => {
    const stream = streamOf(['data: {"a":1}\r\n\r\n']);
    const fetchImpl = fakeFetch(stream);
    const controller = new AbortController();

    const events = await collect(
      readSse('https://relay.example/sse', tokenSource(), controller.signal, fetchImpl),
    );

    expect(events).toEqual([{ a: 1 }]);
  });

  it('reassembles a CRLF-terminated event even when split at the CR/LF boundary', async () => {
    const stream = streamOf(['data: {"a":1}\r', '\n\r\n', 'data: {"b":2}\r\n\r\n']);
    const fetchImpl = fakeFetch(stream);
    const controller = new AbortController();

    const events = await collect(
      readSse('https://relay.example/sse', tokenSource(), controller.signal, fetchImpl),
    );

    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

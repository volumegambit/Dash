import { PluginOpError } from './install.js';

/**
 * DoS bounds for remote plugin/marketplace fetches (I2). A slow-loris URL or a
 * multi-GB body must not stall or OOM the gateway.
 */
/** Abort a remote fetch that has not produced a response in this many ms. */
export const FETCH_TIMEOUT_MS = 30_000;

/** Hard cap on a downloaded plugin archive (50 MiB) — reject anything larger. */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

/** Hard cap on a downloaded marketplace.json document (2 MiB). */
export const MAX_MARKETPLACE_BYTES = 2 * 1024 * 1024;

/**
 * `fetch` with an AbortController timeout. Rejects with `PluginOpError` if the
 * request fails, times out, or returns a non-2xx status. The caller reads the
 * body (with its own size cap) and is responsible for nothing else.
 */
async function fetchWithTimeout(url: string, label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? `timed out after ${FETCH_TIMEOUT_MS}ms`
        : errMsg(err);
    throw new PluginOpError('not_found', `failed to fetch ${label} ${url}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new PluginOpError('not_found', `failed to fetch ${label} ${url}: HTTP ${res.status}`);
  }
  return res;
}

/**
 * Fetch `url` and return its body as a Buffer, enforcing `maxBytes`. The
 * declared `Content-Length` is checked first (cheap reject), then the body is
 * streamed and the running total is capped so a lying/absent header can't slip a
 * huge body through. Oversize → `PluginOpError('corrupt_archive')`.
 */
export async function fetchBufferCapped(
  url: string,
  maxBytes: number,
  label = 'archive',
): Promise<Buffer> {
  const res = await fetchWithTimeout(url, label);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PluginOpError(
      'corrupt_archive',
      `${label} ${url} is too large (${declared} bytes > ${maxBytes} byte cap)`,
    );
  }

  const body = res.body;
  if (!body) {
    // No stream (e.g. an empty body) — fall back to a bounded arrayBuffer read.
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new PluginOpError(
        'corrupt_archive',
        `${label} ${url} exceeds the ${maxBytes} byte cap`,
      );
    }
    return buf;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new PluginOpError(
            'corrupt_archive',
            `${label} ${url} exceeds the ${maxBytes} byte cap`,
          );
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch `url` and return its body as text, enforcing `maxBytes`. Thin wrapper
 * over {@link fetchBufferCapped} so the timeout + size cap apply to a
 * marketplace.json document too.
 */
export async function fetchTextCapped(
  url: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const buf = await fetchBufferCapped(url, maxBytes, label);
  return buf.toString('utf8');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Header } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PluginOpError,
  type PluginScanVerdict,
  installPluginToDir,
  parsePluginSource,
} from './install.js';

describe('parsePluginSource', () => {
  it('parses a git source with subpath and ref', () => {
    expect(parsePluginSource('git:owner/repo/plugins/my-plugin@main')).toEqual({
      kind: 'git',
      owner: 'owner',
      repo: 'repo',
      subpath: 'plugins/my-plugin',
      ref: 'main',
    });
  });

  it('parses a git source without subpath or ref', () => {
    expect(parsePluginSource('git:owner/repo')).toEqual({
      kind: 'git',
      owner: 'owner',
      repo: 'repo',
      subpath: undefined,
      ref: undefined,
    });
  });

  it('parses a git source with subpath but no ref', () => {
    expect(parsePluginSource('git:owner/repo/sub/path')).toEqual({
      kind: 'git',
      owner: 'owner',
      repo: 'repo',
      subpath: 'sub/path',
      ref: undefined,
    });
  });

  it('parses an https url source', () => {
    expect(parsePluginSource('https://example.com/plugins/x.tar.gz')).toEqual({
      kind: 'url',
      url: 'https://example.com/plugins/x.tar.gz',
    });
  });

  it('parses an http url source', () => {
    expect(parsePluginSource('http://example.com/plugins/x.tar.gz')).toEqual({
      kind: 'url',
      url: 'http://example.com/plugins/x.tar.gz',
    });
  });

  it('treats a relative path as a local source', () => {
    expect(parsePluginSource('./my-plugin')).toEqual({ kind: 'local', path: './my-plugin' });
  });

  it('treats an absolute path as a local source', () => {
    expect(parsePluginSource('/abs/path')).toEqual({ kind: 'local', path: '/abs/path' });
  });

  it('treats a home-relative path as a local source', () => {
    expect(parsePluginSource('~/plugins/my-plugin')).toEqual({
      kind: 'local',
      path: '~/plugins/my-plugin',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parsePluginSource('  /abs/path  ')).toEqual({ kind: 'local', path: '/abs/path' });
  });

  it('rejects a malformed git source', () => {
    expect(() => parsePluginSource('git:owner')).toThrow(/Invalid git source/);
  });

  it('rejects an empty source', () => {
    expect(() => parsePluginSource('')).toThrow();
    expect(() => parsePluginSource('   ')).toThrow();
  });

  // C1 (security): a git subpath must never contain a `..` segment or be
  // absolute — otherwise `join(clone.dir, subpath)` escapes the clone and the
  // installer can rename/delete an arbitrary host directory (/etc, ~/.ssh, ...).
  it('rejects a git source whose subpath escapes via ..', () => {
    expect(() => parsePluginSource('git:owner/repo/../../etc')).toThrow(/subpath/i);
  });

  it('rejects a git source whose subpath has an interior .. segment', () => {
    expect(() => parsePluginSource('git:owner/repo/plugins/../../../etc')).toThrow(/subpath/i);
  });

  it('rejects a git source whose subpath ends with a .. segment', () => {
    expect(() => parsePluginSource('git:owner/repo/plugins/..')).toThrow(/subpath/i);
  });

  it('still accepts a legitimate multi-segment git subpath', () => {
    expect(parsePluginSource('git:owner/repo/plugins/my-plugin')).toEqual({
      kind: 'git',
      owner: 'owner',
      repo: 'repo',
      subpath: 'plugins/my-plugin',
      ref: undefined,
    });
  });
});

describe('PluginOpError', () => {
  it('carries a code and message', () => {
    const err = new PluginOpError('not_found', 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PluginOpError);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('nope');
    expect(err.name).toBe('PluginOpError');
  });

  it('exposes code via the generic `code in err` check', () => {
    const err: unknown = new PluginOpError('duplicate', 'dupe');
    expect(err instanceof Error && 'code' in err).toBe(true);
    expect((err as { code?: string }).code).toBe('duplicate');
  });
});

// --- tarball helpers ---------------------------------------------------------

/** A single tar member: a 512-byte header + padded body. */
function tarEntry(name: string, content: string): Buffer {
  const body = Buffer.from(content, 'utf8');
  const header = new Header({
    path: name,
    type: 'File',
    size: body.length,
    mode: 0o644,
    mtime: new Date(),
  });
  header.encode();
  const headerBlock = header.block;
  if (!headerBlock) throw new Error('failed to encode tar header');
  const pad = (512 - (body.length % 512)) % 512;
  return Buffer.concat([headerBlock, body, Buffer.alloc(pad)]);
}

/**
 * Build an UNCOMPRESSED tar archive from `{name: content}` entries, terminated
 * by the two zero blocks tar uses for EOF. The names are written verbatim — so
 * a `../escape.txt` member survives into the archive, which is exactly what the
 * zip-slip test needs (the high-level `tar.c` API would normalize it away).
 */
function buildTar(entries: Record<string, string>): Buffer {
  const blocks = Object.entries(entries).map(([name, content]) => tarEntry(name, content));
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

/** A symlink tar member (size 0; the escape target is the linkpath). */
function tarSymlink(name: string, linkpath: string): Buffer {
  const header = new Header({
    path: name,
    type: 'SymbolicLink',
    linkpath,
    size: 0,
    mode: 0o777,
    mtime: new Date(),
  });
  header.encode();
  const headerBlock = header.block;
  if (!headerBlock) throw new Error('failed to encode tar symlink header');
  return headerBlock; // size 0 → no body, no padding
}

/** Gzip a buffer (so the result is a real `.tar.gz`). */
async function gzip(buf: Buffer): Promise<Buffer> {
  const { gzipSync } = await import('node:zlib');
  return gzipSync(buf);
}

const safe = async (): Promise<PluginScanVerdict> => ({ verdict: 'safe', reasons: [] });

describe('installPluginToDir', () => {
  let work: string;
  let dataDir: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'dash-plugin-install-test-'));
    dataDir = join(work, 'data');
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('rejects a tarball whose member escapes the root (zip-slip → corrupt_archive)', async () => {
    const malicious = await gzip(
      buildTar({
        'my-plugin/.claude-plugin/plugin.json': JSON.stringify({ name: 'my-plugin' }),
        '../escape.txt': 'pwned',
      }),
    );
    const tgz = join(work, 'evil.tar.gz');
    await writeFile(tgz, malicious);

    await expect(installPluginToDir({ dataDir, source: tgz, scanner: safe })).rejects.toMatchObject(
      { code: 'corrupt_archive' },
    );

    // The escaping payload must NOT have been written next to the temp root or
    // anywhere under the data dir.
    expect(existsSync(join(work, 'escape.txt'))).toBe(false);
    expect(existsSync(join(dataDir, 'plugins', 'my-plugin'))).toBe(false);
  });

  it('rejects a tarball whose member is an absolute path (zip-slip → corrupt_archive)', async () => {
    const abs = join(work, 'pwned-abs.txt');
    const malicious = await gzip(
      buildTar({
        'my-plugin/.claude-plugin/plugin.json': JSON.stringify({ name: 'my-plugin' }),
        [abs]: 'pwned',
      }),
    );
    const tgz = join(work, 'evil-abs.tar.gz');
    await writeFile(tgz, malicious);

    await expect(installPluginToDir({ dataDir, source: tgz, scanner: safe })).rejects.toMatchObject(
      { code: 'corrupt_archive' },
    );
    expect(existsSync(abs)).toBe(false);
  });

  // Locks in the symlink defense (the post-write realpath-containment sweep): a
  // two-entry attack — a symlink escaping the root, then a file written THROUGH
  // it — must be rejected, and nothing may land at the escape target.
  it('rejects a tarball with a symlink-through-escape (zip-slip → corrupt_archive)', async () => {
    const sentinel = join(work, 'sentinel');
    await mkdir(sentinel, { recursive: true });
    const malicious = await gzip(
      Buffer.concat([
        tarEntry('my-plugin/.claude-plugin/plugin.json', JSON.stringify({ name: 'my-plugin' })),
        tarSymlink('my-plugin/link', sentinel), // symlink escaping the extraction root
        tarEntry('my-plugin/link/victim.txt', 'PWNED'), // write THROUGH the symlink
        Buffer.alloc(1024),
      ]),
    );
    const tgz = join(work, 'evil-symlink.tar.gz');
    await writeFile(tgz, malicious);

    await expect(installPluginToDir({ dataDir, source: tgz, scanner: safe })).rejects.toMatchObject(
      { code: 'corrupt_archive' },
    );
    // The write-through must NOT have landed at the escape target.
    expect(existsSync(join(sentinel, 'victim.txt'))).toBe(false);
    expect(existsSync(join(dataDir, 'plugins', 'my-plugin'))).toBe(false);
  });

  // C1 (security): a git source whose subpath escapes the clone (`..`) MUST be
  // rejected at parse time — BEFORE any clone runs — and MUST NOT move/remove any
  // directory outside the clone. Without the fix, the parsed subpath
  // `../../sentinel` makes the plugin root `join(clone.dir, '../../sentinel')`,
  // which `moveDir` renames (or cp+rm's) into the plugins dir — destroying an
  // arbitrary host dir the gateway can write.
  //
  // The destructive end-to-end requires cloning a real remote (network), so this
  // offline test pins the two observable guarantees: (1) the install rejects, and
  // (2) a sentinel dir laid down where the escape would point is untouched.
  it('rejects a git source whose subpath escapes the clone and leaves outside dirs untouched', async () => {
    // A sentinel directory the destructive bug would relocate/delete. It sits at
    // the place a `../../<dataDir-parent>` escape would resolve to.
    const sentinel = join(work, 'sentinel');
    await mkdir(sentinel, { recursive: true });
    await writeFile(join(sentinel, 'keep.txt'), 'precious');

    // Rejects at the PARSE gate (message references the subpath) — before any
    // clone. On vulnerable code this either network-clones or escapes; either
    // way it does NOT reject for an invalid-subpath reason.
    await expect(
      installPluginToDir({
        dataDir,
        source: 'git:owner/repo/../../sentinel',
        scanner: safe,
      }),
    ).rejects.toThrow(/subpath/i);

    // The sentinel dir and its contents are untouched; nothing was installed.
    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(join(sentinel, 'keep.txt'))).toBe(true);
    expect(existsSync(join(dataDir, 'plugins', 'sentinel'))).toBe(false);
  });

  // M1: a local-directory source that contains a symlink escaping the tree must
  // be rejected (symmetry with the tarball symlink sweep), and nothing may be
  // installed.
  it('rejects a local dir containing a symlink whose target escapes the tree', async () => {
    const outside = join(work, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'top secret');

    const src = join(work, 'sneaky-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(join(src, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sneaky' }));
    // A symlink inside the plugin tree pointing OUT of it.
    await symlink(outside, join(src, 'escape-link'));

    await expect(
      installPluginToDir({ dataDir, source: src, scanner: safe }),
    ).rejects.toBeInstanceOf(PluginOpError);
    expect(existsSync(join(dataDir, 'plugins', 'sneaky'))).toBe(false);
    // The user's source + the outside dir are untouched.
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
  });

  // M2: a duplicate that wins the dup-check race (target dir created AFTER the
  // existence check, BEFORE the move) surfaces as a structured `duplicate`
  // (→409) rather than an unmapped ENOTEMPTY 500.
  it('maps a move-collision (target already exists) to duplicate', async () => {
    const src = join(work, 'race-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(join(src, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'racer' }));

    // Pre-create a NON-EMPTY target dir so `rename` fails with ENOTEMPTY. The
    // pre-existence dup check sees an empty dir? No — make it match the timing by
    // using a scanner that creates the collision just before the move.
    const collide = join(dataDir, 'plugins', 'racer');
    const scanner = async (): Promise<PluginScanVerdict> => {
      // Create the colliding (non-empty) target dir during the scan, i.e. AFTER
      // the installer's pre-move existence check has already passed.
      await mkdir(collide, { recursive: true });
      await writeFile(join(collide, 'existing.txt'), 'i was here first');
      return { verdict: 'safe', reasons: [] };
    };

    await expect(installPluginToDir({ dataDir, source: src, scanner })).rejects.toMatchObject({
      code: 'duplicate',
    });
  });

  it('installs a valid .tar.gz, using the manifest name, with files on disk', async () => {
    const tar = buildTar({
      'pkg/.claude-plugin/plugin.json': JSON.stringify({
        name: 'cool-plugin',
        version: '1.2.3',
        description: 'a cool plugin',
      }),
      'pkg/commands/hello.md': '# hello',
    });
    const tgz = join(work, 'cool.tar.gz');
    await writeFile(tgz, await gzip(tar));

    const result = await installPluginToDir({ dataDir, source: tgz, scanner: safe });

    expect(result.name).toBe('cool-plugin');
    expect(result.version).toBe('1.2.3');
    expect(result.description).toBe('a cool plugin');
    expect(result.scanVerdict).toBe('safe');
    expect(result.scanReasons).toEqual([]);
    expect(result.source).toBe(tgz);

    const installDir = join(dataDir, 'plugins', 'cool-plugin');
    expect(result.location).toBe(installDir);
    expect(existsSync(installDir)).toBe(true);
    const manifest = JSON.parse(
      await readFile(join(installDir, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(manifest.name).toBe('cool-plugin');
    expect(await readFile(join(installDir, 'commands', 'hello.md'), 'utf8')).toBe('# hello');
  });

  it('installs from a local directory (copied, source left in place)', async () => {
    const src = join(work, 'src-plugin');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'local-plugin' }),
    );
    await mkdir(join(src, 'commands'), { recursive: true });
    await writeFile(join(src, 'commands', 'go.md'), '# go');

    const result = await installPluginToDir({ dataDir, source: src, scanner: safe });

    expect(result.name).toBe('local-plugin');
    expect(existsSync(join(dataDir, 'plugins', 'local-plugin', 'commands', 'go.md'))).toBe(true);
    // Source dir must still exist (we copy, never move the user's source).
    expect(existsSync(join(src, 'commands', 'go.md'))).toBe(true);
  });

  it('falls back to the directory name when no manifest is present', async () => {
    const src = join(work, 'bare-plugin');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'README.md'), 'hi');

    const result = await installPluginToDir({ dataDir, source: src, scanner: safe });
    expect(result.name).toBe('bare-plugin');
    expect(existsSync(join(dataDir, 'plugins', 'bare-plugin'))).toBe(true);
  });

  it('honors the name override when the manifest has no name', async () => {
    const src = join(work, 'NotKebab');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'README.md'), 'hi');

    const result = await installPluginToDir({
      dataDir,
      source: src,
      name: 'overridden-name',
      scanner: safe,
    });
    expect(result.name).toBe('overridden-name');
    expect(existsSync(join(dataDir, 'plugins', 'overridden-name'))).toBe(true);
  });

  it('throws duplicate when a plugin with that name already exists', async () => {
    await mkdir(join(dataDir, 'plugins', 'dup-plugin'), { recursive: true });

    const src = join(work, 'dup-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'dup-plugin' }),
    );

    await expect(installPluginToDir({ dataDir, source: src, scanner: safe })).rejects.toMatchObject(
      {
        code: 'duplicate',
      },
    );
  });

  it('throws dangerous when the scanner returns a dangerous verdict', async () => {
    const src = join(work, 'danger-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'danger-plugin' }),
    );

    const dangerous = async (): Promise<PluginScanVerdict> => ({
      verdict: 'dangerous',
      reasons: ['pipes a download straight into a shell', 'embeds a private key'],
    });

    await expect(
      installPluginToDir({ dataDir, source: src, scanner: dangerous }),
    ).rejects.toMatchObject({
      code: 'dangerous',
      message: 'pipes a download straight into a shell; embeds a private key',
    });
    // Nothing installed.
    expect(existsSync(join(dataDir, 'plugins', 'danger-plugin'))).toBe(false);
  });

  it('proceeds when the scanner returns suspicious', async () => {
    const src = join(work, 'sus-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'sus-plugin' }),
    );

    const suspicious = async (): Promise<PluginScanVerdict> => ({
      verdict: 'suspicious',
      reasons: ['reads environment variables'],
    });

    const result = await installPluginToDir({ dataDir, source: src, scanner: suspicious });
    expect(result.name).toBe('sus-plugin');
    expect(result.scanVerdict).toBe('suspicious');
    expect(result.scanReasons).toEqual(['reads environment variables']);
    expect(existsSync(join(dataDir, 'plugins', 'sus-plugin'))).toBe(true);
  });

  it('throws scan_failed when the scanner throws', async () => {
    const src = join(work, 'throw-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'throw-plugin' }),
    );

    const throwing = async (): Promise<PluginScanVerdict> => {
      throw new Error('scanner blew up');
    };

    await expect(
      installPluginToDir({ dataDir, source: src, scanner: throwing }),
    ).rejects.toMatchObject({ code: 'scan_failed' });
    expect(existsSync(join(dataDir, 'plugins', 'throw-plugin'))).toBe(false);
  });

  it('throws invalid_manifest when the manifest fails validation', async () => {
    const src = join(work, 'bad-manifest-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'NotKebabCase' }),
    );

    await expect(installPluginToDir({ dataDir, source: src, scanner: safe })).rejects.toMatchObject(
      {
        code: 'invalid_manifest',
      },
    );
  });

  it('throws not_found for a bad url', async () => {
    await expect(
      installPluginToDir({
        dataDir,
        source: 'https://127.0.0.1:1/does-not-exist.tar.gz',
        scanner: safe,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  // I2 (DoS): an archive whose declared Content-Length exceeds the cap is
  // rejected before the body is buffered.
  it('rejects a remote archive whose Content-Length exceeds the size cap', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(Buffer.from('x'), {
          status: 200,
          headers: { 'content-length': String(100 * 1024 * 1024) }, // > 50 MiB cap
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        installPluginToDir({ dataDir, source: 'https://example.com/big.tar.gz', scanner: safe }),
      ).rejects.toMatchObject({ code: 'corrupt_archive' });
      // The bounded fetch passes an AbortController signal.
      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/big.tar.gz',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // I2 (DoS): a body that lies about (or omits) Content-Length is still capped by
  // the streamed byte counter.
  it('rejects a remote archive that streams more bytes than the cap', async () => {
    // A ReadableStream that emits 1 MiB chunks forever (no Content-Length).
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        installPluginToDir({ dataDir, source: 'https://example.com/stream.tar.gz', scanner: safe }),
      ).rejects.toMatchObject({ code: 'corrupt_archive' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws not_found for a missing local path', async () => {
    await expect(
      installPluginToDir({ dataDir, source: join(work, 'nope'), scanner: safe }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not leave temp dirs behind after a successful install', async () => {
    const src = join(work, 'clean-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'clean-plugin' }),
    );
    const result = await installPluginToDir({ dataDir, source: src, scanner: safe });
    expect(existsSync(result.location)).toBe(true);
    // The plugins dir should contain exactly the one install, no temp leftovers.
    const { readdir } = await import('node:fs/promises');
    const installed = await readdir(join(dataDir, 'plugins'));
    expect(installed).toEqual(['clean-plugin']);
  });
});

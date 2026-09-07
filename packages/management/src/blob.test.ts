import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBlobSigner, imageContentType, isWithin } from './blob.js';

const WORKSPACES = '/data/workspaces';
const CONV = 'conv-123';
const workspaceRoot = (conversationId: string) => join(WORKSPACES, conversationId);
const secret = 'unit-test-secret';

function makeSigner(overrides?: { now?: () => number; ttlMs?: number }) {
  return createBlobSigner({ secret, workspaceRoot, ...overrides });
}

describe('isWithin', () => {
  it('accepts the root itself and nested paths', () => {
    expect(isWithin('/data/ws/conv', '/data/ws/conv')).toBe(true);
    expect(isWithin('/data/ws/conv', '/data/ws/conv/a.png')).toBe(true);
    expect(isWithin('/data/ws/conv', '/data/ws/conv/sub/dir/a.png')).toBe(true);
  });

  it('rejects traversal out of the root', () => {
    expect(isWithin('/data/ws/conv', '/data/ws/conv/../other/a.png')).toBe(false);
    expect(isWithin('/data/ws/conv', '/data/ws/../secret')).toBe(false);
    expect(isWithin('/data/ws/conv', '/etc/passwd')).toBe(false);
  });

  it('rejects a sibling whose name is a prefix of the root', () => {
    // The classic prefix-collision bug: /conv vs /conv-evil.
    expect(isWithin('/data/ws/conv', '/data/ws/conv-evil/a.png')).toBe(false);
  });
});

describe('createBlobSigner sign/verify', () => {
  it('round-trips a path inside the workspace', () => {
    const signer = makeSigner();
    const path = join(WORKSPACES, CONV, 'image.png');
    const id = signer.sign({ path, conversationId: CONV });
    const claims = signer.verify(id);
    expect(claims).not.toBeNull();
    expect(claims?.path).toBe(path);
    expect(claims?.conversationId).toBe(CONV);
    expect(typeof claims?.exp).toBe('number');
  });

  it('refuses to sign a path outside the workspace', () => {
    const signer = makeSigner();
    expect(() => signer.sign({ path: '/etc/passwd', conversationId: CONV })).toThrow(
      /outside workspace/,
    );
    expect(() =>
      signer.sign({ path: join(WORKSPACES, CONV, '..', 'other', 'x.png'), conversationId: CONV }),
    ).toThrow(/outside workspace/);
  });

  it('rejects a tampered payload', () => {
    const signer = makeSigner();
    const id = signer.sign({ path: join(WORKSPACES, CONV, 'a.png'), conversationId: CONV });
    const [payload, sig] = id.split('.');
    // Flip one char in the payload; the signature no longer matches.
    const tampered = `${payload.slice(0, -1)}${payload.slice(-1) === 'A' ? 'B' : 'A'}.${sig}`;
    expect(signer.verify(tampered)).toBeNull();
  });

  it('rejects a bad signature', () => {
    const signer = makeSigner();
    const id = signer.sign({ path: join(WORKSPACES, CONV, 'a.png'), conversationId: CONV });
    const [payload] = id.split('.');
    expect(signer.verify(`${payload}.not-the-real-signature`)).toBeNull();
  });

  it('rejects an id signed with a different secret', () => {
    const a = makeSigner();
    const b = createBlobSigner({ secret: 'other-secret', workspaceRoot });
    const id = a.sign({ path: join(WORKSPACES, CONV, 'a.png'), conversationId: CONV });
    expect(b.verify(id)).toBeNull();
  });

  it('rejects an expired id', () => {
    let clock = 1_000_000;
    const signer = makeSigner({ now: () => clock, ttlMs: 1000 });
    const id = signer.sign({ path: join(WORKSPACES, CONV, 'a.png'), conversationId: CONV });
    expect(signer.verify(id)).not.toBeNull(); // still valid
    clock += 1001; // past expiry
    expect(signer.verify(id)).toBeNull();
  });

  it('rejects malformed ids without throwing', () => {
    const signer = makeSigner();
    for (const bad of ['', '.', 'nopayload.', '.nosig', 'onlyonepart', 'a.b.c']) {
      expect(signer.verify(bad)).toBeNull();
    }
    // biome-ignore lint/suspicious/noExplicitAny: intentionally exercising bad input
    expect(signer.verify(undefined as any)).toBeNull();
  });

  it('rejects a valid signature whose claimed path escaped the workspace after signing', () => {
    // Sign under one workspace mapping, then verify with a mapping that no
    // longer contains the path — defence in depth beyond the sign-time check.
    const signer = createBlobSigner({
      secret,
      workspaceRoot: (id) => (id === CONV ? join(WORKSPACES, CONV) : '/somewhere/else'),
    });
    const id = signer.sign({ path: join(WORKSPACES, CONV, 'a.png'), conversationId: CONV });
    // A verifier that maps every conversation elsewhere must reject it.
    const strict = createBlobSigner({ secret, workspaceRoot: () => '/somewhere/else' });
    expect(strict.verify(id)).toBeNull();
  });
});

describe('imageContentType', () => {
  it('maps known image extensions', () => {
    expect(imageContentType('/a/b.png')).toBe('image/png');
    expect(imageContentType('/a/b.JPG')).toBe('image/jpeg');
    expect(imageContentType('photo.jpeg')).toBe('image/jpeg');
    expect(imageContentType('anim.gif')).toBe('image/gif');
    expect(imageContentType('x.webp')).toBe('image/webp');
  });

  it('returns null for unsupported or extensionless paths', () => {
    expect(imageContentType('/a/b.txt')).toBeNull();
    expect(imageContentType('/a/b.svg')).toBeNull();
    expect(imageContentType('/a/noext')).toBeNull();
    expect(imageContentType('')).toBeNull();
  });
});

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Blob transport for outbound image delivery (DASH-11).
 *
 * A tool that produces an image on the gateway mints a short-lived, HMAC-signed
 * blob id over `{ path, conversationId, exp }`. Clients resolve that id against
 * their known gateway base (`GET /blob/:id`); the endpoint verifies the
 * signature and expiry, re-checks that the path is inside the conversation's
 * workspace, then streams the bytes. Because the id is signed, the endpoint
 * never trusts a client-supplied path and cannot be walked outside the
 * workspace even if the HMAC secret is unknown to the caller.
 *
 * Design: docs/plans/2026-09-06-outbound-image-delivery-design.md
 */

/** Decoded, verified payload carried inside a blob id. */
export interface BlobClaims {
  /** Absolute path to the file on the gateway machine. */
  path: string;
  /** Conversation whose workspace scopes this file. */
  conversationId: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

export interface BlobSigner {
  /** Mint a signed id for a file. Throws if `path` escapes `workspaceRoot`. */
  sign(claims: { path: string; conversationId: string }): string;
  /**
   * Verify + decode an id. Returns the claims on success, or `null` for any
   * failure (bad format, bad signature, expired). Never throws on bad input.
   */
  verify(id: string): BlobClaims | null;
}

export interface BlobSignerOptions {
  /** HMAC secret. MUST be stable across a gateway process's lifetime. */
  secret: string;
  /**
   * Resolve a conversation id to the absolute root its files must stay under
   * (`<dataDir>/workspaces/<conversationId>` or the agent workspace). Used both
   * when signing (to reject an out-of-workspace path up front) and when
   * verifying (defence in depth, in case the workspace mapping changed).
   */
  workspaceRoot: (conversationId: string) => string;
  /** Token lifetime in ms. Default 10 minutes. */
  ttlMs?: number;
  /** Clock injection for tests. Default `Date.now`. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * True when `child` is `root` itself or lives strictly beneath it. Guards
 * against `../` traversal and against a sibling whose name is a prefix of the
 * root (e.g. `/ws/conv` vs `/ws/conv-evil`). Both inputs must be absolute.
 */
export function isWithin(root: string, child: string): boolean {
  const r = resolve(root);
  const c = resolve(child);
  if (c === r) return true;
  const rel = relative(r, c);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function createBlobSigner(options: BlobSignerOptions): BlobSigner {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  function mac(payloadB64: string): string {
    return base64url(createHmac('sha256', options.secret).update(payloadB64).digest());
  }

  return {
    sign({ path, conversationId }) {
      const abs = resolve(path);
      const root = options.workspaceRoot(conversationId);
      if (!isWithin(root, abs)) {
        throw new Error(
          `blob: refusing to sign path outside workspace (conversation=${conversationId})`,
        );
      }
      const claims: BlobClaims = { path: abs, conversationId, exp: now() + ttlMs };
      const payload = base64url(Buffer.from(JSON.stringify(claims), 'utf-8'));
      return `${payload}.${mac(payload)}`;
    },

    verify(id) {
      if (typeof id !== 'string') return null;
      const dot = id.indexOf('.');
      if (dot <= 0 || dot === id.length - 1) return null;
      const payload = id.slice(0, dot);
      const sig = id.slice(dot + 1);

      // Constant-time signature comparison.
      const expected = mac(payload);
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

      let claims: BlobClaims;
      try {
        claims = JSON.parse(fromBase64url(payload).toString('utf-8')) as BlobClaims;
      } catch {
        return null;
      }
      if (
        typeof claims?.path !== 'string' ||
        typeof claims?.conversationId !== 'string' ||
        typeof claims?.exp !== 'number'
      ) {
        return null;
      }
      if (now() >= claims.exp) return null;

      // Defence in depth: re-verify the path is still inside the workspace the
      // conversation maps to now, not only the one it mapped to at sign time.
      const root = options.workspaceRoot(claims.conversationId);
      if (!isWithin(root, claims.path)) return null;

      return claims;
    },
  };
}

/** Map a file extension to an allowed image content-type, or null. */
export function imageContentType(path: string): string | null {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  switch (lower.slice(dot + 1)) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

/** Exposed for tests: the platform path separator this module guards against. */
export const PATH_SEP = sep;

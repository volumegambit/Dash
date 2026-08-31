// @vitest-environment node
//
// The CSP is shipped in two places that must not drift: the `<meta>` tag in
// `index.html` (which Vite templates at build time) and the header written out
// in README.md for the production host to serve. These tests pin both.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const indexHtml = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

function metaPolicy(): string {
  const match = indexHtml.match(/http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/);
  if (!match) throw new Error('index.html has no Content-Security-Policy meta tag');
  return match[1];
}

function directive(policy: string, name: string): string {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  if (found === undefined) throw new Error(`CSP has no ${name} directive: ${policy}`);
  return found;
}

describe('Content-Security-Policy', () => {
  it('pins connect-src to this deployment rather than a blanket https:', () => {
    const connect = directive(metaPolicy(), 'connect-src');
    // The old policy was `connect-src 'self' https:` — any HTTPS origin.
    expect(connect).not.toMatch(/(^|\s)https:(\s|$)/);
    expect(connect).toContain("'self'");
    // Templated per-deployment by Vite from the same env `src/config.ts` reads.
    expect(connect).toContain('%VITE_CONTROL_PLANE_URL%');
    expect(connect).toContain('https://*.%VITE_RELAY_DOMAIN%');
  });

  it('allows wss: to the relay explicitly — the chat socket needs its own source', () => {
    // `connect-src` covers WebSockets, but an `https://` source does NOT match
    // a `wss://` URL, so the scheme has to be listed in its own right.
    expect(directive(metaPolicy(), 'connect-src')).toContain('wss://*.%VITE_RELAY_DOMAIN%');
  });

  it('allows Clerk where Clerk actually loads from, and nowhere else', () => {
    const policy = metaPolicy();
    expect(directive(policy, 'script-src')).toContain('https://*.clerk.accounts.dev');
    expect(directive(policy, 'connect-src')).toContain('https://*.clerk.accounts.dev');
  });

  it('allows img-src from any https: origin plus data:, for model-generated markdown images', () => {
    // Unlike connect-src/script-src, img-src is deliberately NOT pinned to a
    // fixed allowlist: assistant replies can link to arbitrary remote image
    // hosts. react-markdown's defaultUrlTransform strips javascript:/data:
    // image *sources* from markdown before they reach the DOM, so this is
    // safe to widen. Clerk's avatar CDN (https://img.clerk.com) is subsumed
    // by the blanket https:, so it's no longer listed by name.
    const img = directive(metaPolicy(), 'img-src');
    expect(img).toContain("'self'");
    expect(img).toContain('https:');
    expect(img).toContain('data:');
  });

  it('keeps the baseline hardening directives', () => {
    const policy = metaPolicy();
    expect(directive(policy, 'default-src')).toBe("default-src 'self'");
    expect(directive(policy, 'object-src')).toBe("object-src 'none'");
    expect(directive(policy, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(policy, 'form-action')).toBe("form-action 'self'");
  });

  it('is mirrored verbatim in the README the production host follows', () => {
    // Drift here means the header a real deployment serves is weaker (or
    // broader) than the one this app was actually tested against.
    expect(readme).toContain(`Content-Security-Policy: ${metaPolicy()}`);
  });
});

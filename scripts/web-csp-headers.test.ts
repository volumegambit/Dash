import { extractCsp, renderHeaders } from './web-csp-headers.mjs';

const html = `<!doctype html><html><head>
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; connect-src 'self' https://api.stg.relay.example.com wss://*.stg.relay.example.com; object-src 'none'"
    />
    <title>Dash</title></head><body></body></html>`;

describe('web CSP headers', () => {
  it('extracts the policy from the built index.html meta tag', () => {
    expect(extractCsp(html)).toBe(
      "default-src 'self'; connect-src 'self' https://api.stg.relay.example.com wss://*.stg.relay.example.com; object-src 'none'",
    );
  });

  it('throws when the meta tag is missing', () => {
    expect(() => extractCsp('<html></html>')).toThrow(/Content-Security-Policy/);
  });

  it('renders a Cloudflare Pages _headers file for every path', () => {
    const out = renderHeaders("default-src 'self'");
    expect(out).toBe(
      [
        '/*',
        "  Content-Security-Policy: default-src 'self'",
        '  X-Content-Type-Options: nosniff',
        '  Referrer-Policy: strict-origin-when-cross-origin',
        '',
      ].join('\n'),
    );
  });
});

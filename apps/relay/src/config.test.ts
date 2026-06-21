import { describe, expect, it } from 'vitest';
import { loadRelayConfig, parseRelayFlags } from './config.js';

describe('parseRelayFlags', () => {
  it('returns empty for no flags', () => {
    expect(parseRelayFlags([])).toEqual({});
  });

  it('parses --port, --host and --relay-token', () => {
    expect(parseRelayFlags(['--port', '9000', '--host', '0.0.0.0', '--relay-token', 'rt'])).toEqual(
      { port: 9000, host: '0.0.0.0', relayToken: 'rt' },
    );
  });

  it('parses --admin-secret', () => {
    expect(parseRelayFlags(['--admin-secret', 'sek'])).toEqual({ adminSecret: 'sek' });
  });

  it('parses --dial-token-public-key and --store-path', () => {
    expect(
      parseRelayFlags(['--dial-token-public-key', '/k/pub.pem', '--store-path', '/d/creds.db']),
    ).toEqual({ dialTokenPublicKeyPath: '/k/pub.pem', storePath: '/d/creds.db' });
  });

  it('ignores flags without values', () => {
    expect(parseRelayFlags(['--relay-token'])).toEqual({});
  });
});

describe('loadRelayConfig', () => {
  it('applies defaults when nothing but a token is set', () => {
    expect(loadRelayConfig({ env: { RELAY_TOKEN: 'secret' } })).toEqual({
      port: 8443,
      host: '127.0.0.1',
      relayToken: 'secret',
    });
  });

  it('reads port, host and token from env', () => {
    expect(
      loadRelayConfig({
        env: { RELAY_PORT: '9100', RELAY_HOST: '0.0.0.0', RELAY_TOKEN: 'envtoken' },
      }),
    ).toEqual({ port: 9100, host: '0.0.0.0', relayToken: 'envtoken' });
  });

  it('lets flags override env', () => {
    expect(
      loadRelayConfig({
        argv: ['--port', '9200', '--relay-token', 'flagtoken'],
        env: { RELAY_PORT: '9100', RELAY_TOKEN: 'envtoken' },
      }),
    ).toEqual({ port: 9200, host: '127.0.0.1', relayToken: 'flagtoken' });
  });

  it('reads the optional admin secret from flag or env', () => {
    expect(
      loadRelayConfig({ argv: ['--admin-secret', 'flagsek'], env: { RELAY_TOKEN: 't' } })
        .adminSecret,
    ).toBe('flagsek');
    expect(
      loadRelayConfig({ env: { RELAY_TOKEN: 't', RELAY_ADMIN_SECRET: 'envsek' } }).adminSecret,
    ).toBe('envsek');
    // Absent → undefined (admin API disabled).
    expect(loadRelayConfig({ env: { RELAY_TOKEN: 't' } }).adminSecret).toBeUndefined();
  });

  it('reads hosted-mode paths from flags', () => {
    const cfg = loadRelayConfig({
      argv: ['--dial-token-public-key', '/k/pub.pem', '--store-path', '/d/creds.db'],
      env: { RELAY_TOKEN: 't' },
    });
    expect(cfg.dialTokenPublicKeyPath).toBe('/k/pub.pem');
    expect(cfg.storePath).toBe('/d/creds.db');
  });

  it('reads hosted-mode paths from env', () => {
    const cfg = loadRelayConfig({
      env: {
        RELAY_TOKEN: 't',
        RELAY_DIAL_TOKEN_PUBLIC_KEY: '/env/pub.pem',
        RELAY_STORE_PATH: '/env/creds.db',
      },
    });
    expect(cfg.dialTokenPublicKeyPath).toBe('/env/pub.pem');
    expect(cfg.storePath).toBe('/env/creds.db');
  });

  it('lets hosted-mode flags override env', () => {
    const cfg = loadRelayConfig({
      argv: ['--dial-token-public-key', '/flag/pub.pem'],
      env: { RELAY_TOKEN: 't', RELAY_DIAL_TOKEN_PUBLIC_KEY: '/env/pub.pem' },
    });
    expect(cfg.dialTokenPublicKeyPath).toBe('/flag/pub.pem');
  });

  it('does not require a relay token when a dial-token public key is supplied', () => {
    expect(() =>
      loadRelayConfig({ argv: ['--dial-token-public-key', '/k/pub.pem'], env: {} }),
    ).not.toThrow();
  });

  it('throws when no relay token is provided', () => {
    expect(() => loadRelayConfig({ argv: [], env: {} })).toThrow(/relay token/i);
  });
});

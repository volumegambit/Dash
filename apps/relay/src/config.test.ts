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

  it('throws when no relay token is provided', () => {
    expect(() => loadRelayConfig({ argv: [], env: {} })).toThrow(/relay token/i);
  });
});

import { describe, expect, it } from 'vitest';
import { loadConfig, parseControlPlaneFlags } from './config.js';

/** Minimal env that satisfies the two required fields, for tests focused on other behavior. */
const requiredEnv = {
  RELAY_CP_RELAY_ADMIN_SECRET: 'master',
  RELAY_CP_DIAL_TOKEN_PRIVATE_KEY: '/k/cp.pem',
};

describe('parseControlPlaneFlags', () => {
  it('returns empty for no flags', () => {
    expect(parseControlPlaneFlags([])).toEqual({});
  });

  it('parses every flag', () => {
    expect(
      parseControlPlaneFlags([
        '--port',
        '9500',
        '--db-path',
        '/d/cp.db',
        '--relay-admin-url',
        'https://relay.example/admin',
        '--relay-admin-secret',
        'sek',
        '--relay-zone',
        'relay.example',
        '--dial-token-ttl',
        '3600',
        '--dial-token-private-key',
        '/k/cp.pem',
      ]),
    ).toEqual({
      port: 9500,
      dbPath: '/d/cp.db',
      relayAdminUrl: 'https://relay.example/admin',
      relayAdminSecret: 'sek',
      relayZone: 'relay.example',
      dialTokenTtlSec: 3600,
      dialTokenPrivateKeyPath: '/k/cp.pem',
    });
  });

  it('ignores flags without values', () => {
    expect(parseControlPlaneFlags(['--relay-admin-secret'])).toEqual({});
  });
});

describe('loadConfig', () => {
  it('applies defaults when only the required fields are set', () => {
    const cfg = loadConfig({ env: requiredEnv });
    expect(cfg.port).toBe(9400);
    expect(cfg.dialTokenTtlSec).toBe(86400);
    expect(cfg.relayAdminSecret).toBe('master');
    expect(cfg.dialTokenPrivateKeyPath).toBe('/k/cp.pem');
  });

  it('reads every value from RELAY_CP_* env', () => {
    const cfg = loadConfig({
      env: {
        RELAY_CP_PORT: '9600',
        RELAY_CP_DB_PATH: '/env/cp.db',
        RELAY_CP_RELAY_ADMIN_URL: 'https://env.relay/admin',
        RELAY_CP_RELAY_ADMIN_SECRET: 'envsek',
        RELAY_CP_RELAY_ZONE: 'env.relay',
        RELAY_CP_DIAL_TOKEN_TTL: '7200',
        RELAY_CP_DIAL_TOKEN_PRIVATE_KEY: '/env/cp.pem',
      },
    });
    expect(cfg).toMatchObject({
      port: 9600,
      dbPath: '/env/cp.db',
      relayAdminUrl: 'https://env.relay/admin',
      relayAdminSecret: 'envsek',
      relayZone: 'env.relay',
      dialTokenTtlSec: 7200,
      dialTokenPrivateKeyPath: '/env/cp.pem',
    });
  });

  it('reads the optional WorkOS keys from env when both present', () => {
    const cfg = loadConfig({
      env: {
        ...requiredEnv,
        RELAY_CP_WORKOS_API_KEY: 'sk_test',
        RELAY_CP_WORKOS_CLIENT_ID: 'client_123',
      },
    });
    expect(cfg.workos).toEqual({ apiKey: 'sk_test', clientId: 'client_123' });
  });

  it('omits workos when keys are absent', () => {
    expect(loadConfig({ env: requiredEnv }).workos).toBeUndefined();
  });

  it('lets flags override env', () => {
    const cfg = loadConfig({
      argv: ['--port', '9700', '--relay-zone', 'flag.relay'],
      env: {
        ...requiredEnv,
        RELAY_CP_PORT: '9600',
        RELAY_CP_RELAY_ZONE: 'env.relay',
      },
    });
    expect(cfg.port).toBe(9700);
    expect(cfg.relayZone).toBe('flag.relay');
  });

  it('throws when relayAdminSecret is missing', () => {
    expect(() => loadConfig({ env: { RELAY_CP_DIAL_TOKEN_PRIVATE_KEY: '/k/cp.pem' } })).toThrow(
      /relay admin secret/i,
    );
  });

  it('throws when dialTokenPrivateKeyPath is missing', () => {
    expect(() => loadConfig({ env: { RELAY_CP_RELAY_ADMIN_SECRET: 'master' } })).toThrow(
      /dial.token private key/i,
    );
  });
});

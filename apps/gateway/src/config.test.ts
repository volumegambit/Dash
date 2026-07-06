import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SWARM_CONFIG,
  parseFlags,
  resolveSwarmConfig,
  swarmOverridesFromEnv,
} from './config.js';

describe('parseFlags', () => {
  it('returns empty for no flags', () => {
    expect(parseFlags([])).toEqual({});
  });

  it('parses --management-port flag', () => {
    expect(parseFlags(['--management-port', '9400'])).toEqual({ managementPort: 9400 });
  });

  it('parses --token flag', () => {
    expect(parseFlags(['--token', 'my-token'])).toEqual({ token: 'my-token' });
  });

  it('parses --data-dir flag', () => {
    expect(parseFlags(['--data-dir', '/tmp/gateway-data'])).toEqual({
      dataDir: '/tmp/gateway-data',
    });
  });

  it('parses --channel-port flag', () => {
    expect(parseFlags(['--channel-port', '9201'])).toEqual({ channelPort: 9201 });
  });

  it('parses --chat-token flag', () => {
    expect(parseFlags(['--chat-token', 'chat-secret'])).toEqual({ chatToken: 'chat-secret' });
  });

  it('parses --relay-url flag', () => {
    expect(parseFlags(['--relay-url', 'wss://relay.example.com'])).toEqual({
      relayUrl: 'wss://relay.example.com',
    });
  });

  it('parses --relay-token flag', () => {
    expect(parseFlags(['--relay-token', 'relay-secret'])).toEqual({ relayToken: 'relay-secret' });
  });

  it('parses --gateway-id flag', () => {
    expect(parseFlags(['--gateway-id', 'gw-abc'])).toEqual({ gatewayId: 'gw-abc' });
  });

  it('parses --control-plane-url', () => {
    expect(parseFlags(['--control-plane-url', 'https://cp.example.com'])).toEqual({
      controlPlaneUrl: 'https://cp.example.com',
    });
  });

  it('parses relay flags together', () => {
    expect(
      parseFlags([
        '--relay-url',
        'wss://relay.example.com',
        '--relay-token',
        'rt',
        '--gateway-id',
        'gw-1',
      ]),
    ).toEqual({
      relayUrl: 'wss://relay.example.com',
      relayToken: 'rt',
      gatewayId: 'gw-1',
    });
  });

  it('parses multiple flags', () => {
    expect(
      parseFlags(['--management-port', '9400', '--token', 'my-token', '--data-dir', '/tmp/data']),
    ).toEqual({
      managementPort: 9400,
      token: 'my-token',
      dataDir: '/tmp/data',
    });
  });

  it('ignores flags without values', () => {
    expect(parseFlags(['--token'])).toEqual({});
  });
});

describe('swarmOverridesFromEnv', () => {
  it('returns empty overrides and no warnings when no swarm env vars are set', () => {
    expect(swarmOverridesFromEnv({})).toEqual({ overrides: {}, warnings: [] });
  });

  it('reads the global ceiling from SWARM_MAX_CONCURRENT_WORKERS_GLOBAL', () => {
    const { overrides, warnings } = swarmOverridesFromEnv({
      SWARM_MAX_CONCURRENT_WORKERS_GLOBAL: '32',
    });
    expect(overrides).toEqual({ maxConcurrentWorkersGlobal: 32 });
    expect(warnings).toEqual([]);
  });

  it('reads every per-agent default cap from its SWARM_DEFAULT_* variable', () => {
    const { overrides, warnings } = swarmOverridesFromEnv({
      SWARM_DEFAULT_MAX_CONCURRENT_WORKERS: '4',
      SWARM_DEFAULT_MAX_WORKERS_PER_RUN: '48',
      SWARM_DEFAULT_MAX_STEERS_PER_WORKER: '20',
      SWARM_DEFAULT_MAX_RUN_SECONDS: '3600',
    });
    expect(overrides).toEqual({
      defaults: {
        maxConcurrentWorkers: 4,
        maxWorkersPerRun: 48,
        maxSteersPerWorker: 20,
        maxRunSeconds: 3600,
      },
    });
    expect(warnings).toEqual([]);
  });

  it('only includes the defaults that are actually set so the merge fills the rest', () => {
    const { overrides } = swarmOverridesFromEnv({ SWARM_DEFAULT_MAX_RUN_SECONDS: '900' });
    expect(overrides).toEqual({ defaults: { maxRunSeconds: 900 } });

    const resolved = resolveSwarmConfig(overrides);
    expect(resolved.defaults.maxRunSeconds).toBe(900);
    expect(resolved.defaults.maxConcurrentWorkers).toBe(
      DEFAULT_SWARM_CONFIG.defaults.maxConcurrentWorkers,
    );
    expect(resolved.maxConcurrentWorkersGlobal).toBe(
      DEFAULT_SWARM_CONFIG.maxConcurrentWorkersGlobal,
    );
  });

  it('rejects non-numeric values with a warning naming the variable', () => {
    const { overrides, warnings } = swarmOverridesFromEnv({
      SWARM_MAX_CONCURRENT_WORKERS_GLOBAL: 'lots',
    });
    expect(overrides).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SWARM_MAX_CONCURRENT_WORKERS_GLOBAL');
    expect(warnings[0]).toContain('lots');
  });

  it('rejects zero, negative, and fractional values', () => {
    const { overrides, warnings } = swarmOverridesFromEnv({
      SWARM_MAX_CONCURRENT_WORKERS_GLOBAL: '0',
      SWARM_DEFAULT_MAX_WORKERS_PER_RUN: '-5',
      SWARM_DEFAULT_MAX_RUN_SECONDS: '1.5',
    });
    expect(overrides).toEqual({});
    expect(warnings).toHaveLength(3);
  });

  it('keeps valid overrides while warning about invalid ones', () => {
    const { overrides, warnings } = swarmOverridesFromEnv({
      SWARM_MAX_CONCURRENT_WORKERS_GLOBAL: '64',
      SWARM_DEFAULT_MAX_STEERS_PER_WORKER: 'nope',
    });
    expect(overrides).toEqual({ maxConcurrentWorkersGlobal: 64 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SWARM_DEFAULT_MAX_STEERS_PER_WORKER');
  });

  it('treats an empty-string variable as unset', () => {
    expect(swarmOverridesFromEnv({ SWARM_MAX_CONCURRENT_WORKERS_GLOBAL: '' })).toEqual({
      overrides: {},
      warnings: [],
    });
  });
});

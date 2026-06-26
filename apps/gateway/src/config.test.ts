import { describe, expect, it } from 'vitest';
import { parseFlags } from './config.js';

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

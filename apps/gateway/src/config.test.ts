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

  it('parses multiple flags', () => {
    expect(
      parseFlags([
        '--management-port',
        '9400',
        '--token',
        'my-token',
        '--data-dir',
        '/tmp/data',
      ]),
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

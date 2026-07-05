import {
  DEFAULT_CHANNEL_PORT,
  DEFAULT_MANAGEMENT_PORT,
  resolveGatewayPorts,
} from './ports.js';

describe('resolveGatewayPorts', () => {
  it('returns 9300/9200 defaults when env vars are unset', () => {
    expect(resolveGatewayPorts({})).toEqual({ managementPort: 9300, channelPort: 9200 });
    expect(DEFAULT_MANAGEMENT_PORT).toBe(9300);
    expect(DEFAULT_CHANNEL_PORT).toBe(9200);
  });

  it('treats empty and whitespace-only values as unset', () => {
    expect(
      resolveGatewayPorts({ MC_GATEWAY_MANAGEMENT_PORT: '', MC_GATEWAY_CHANNEL_PORT: '  ' }),
    ).toEqual({ managementPort: 9300, channelPort: 9200 });
  });

  it('parses valid overrides, independently per var', () => {
    expect(resolveGatewayPorts({ MC_GATEWAY_MANAGEMENT_PORT: '9310' })).toEqual({
      managementPort: 9310,
      channelPort: 9200,
    });
    expect(resolveGatewayPorts({ MC_GATEWAY_CHANNEL_PORT: '9210' })).toEqual({
      managementPort: 9300,
      channelPort: 9210,
    });
    expect(
      resolveGatewayPorts({
        MC_GATEWAY_MANAGEMENT_PORT: '9310',
        MC_GATEWAY_CHANNEL_PORT: '9210',
      }),
    ).toEqual({ managementPort: 9310, channelPort: 9210 });
  });

  it.each([
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['negative', '-1'],
    ['too large', '65536'],
    ['float', '9310.5'],
  ])('throws on %s value, naming the env var', (_label, raw) => {
    expect(() => resolveGatewayPorts({ MC_GATEWAY_MANAGEMENT_PORT: raw })).toThrow(
      /MC_GATEWAY_MANAGEMENT_PORT/,
    );
    expect(() => resolveGatewayPorts({ MC_GATEWAY_CHANNEL_PORT: raw })).toThrow(
      /MC_GATEWAY_CHANNEL_PORT/,
    );
  });

  it('throws when both ports are set to the same value', () => {
    expect(() =>
      resolveGatewayPorts({
        MC_GATEWAY_MANAGEMENT_PORT: '9310',
        MC_GATEWAY_CHANNEL_PORT: '9310',
      }),
    ).toThrow(/must differ/);
  });

  it('reads process.env when no env object is passed', () => {
    // The test runner sets no MC_GATEWAY_* overrides, so defaults come back.
    expect(resolveGatewayPorts()).toEqual({ managementPort: 9300, channelPort: 9200 });
  });
});

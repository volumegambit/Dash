import { interpolateConfigEnvVars, interpolateEnvVars } from './env.js';
import type { McpServerConfig } from './types.js';

describe('interpolateEnvVars', () => {
  it('replaces ${VAR} with env value', () => {
    const result = interpolateEnvVars('token: ${TEST_TOKEN}', { TEST_TOKEN: 'abc123' });
    expect(result).toBe('token: abc123');
  });

  it('leaves unmatched vars as empty string', () => {
    const result = interpolateEnvVars('${MISSING}', {});
    expect(result).toBe('');
  });

  it('handles multiple vars in one string', () => {
    const result = interpolateEnvVars('${A}:${B}', { A: 'x', B: 'y' });
    expect(result).toBe('x:y');
  });

  it('returns string unchanged when no vars present', () => {
    const result = interpolateEnvVars('plain text', {});
    expect(result).toBe('plain text');
  });

  it('calls logger.warn for unresolved vars', () => {
    const warns: string[] = [];
    const logger = { info: () => {}, warn: (m: string) => warns.push(m), error: () => {} };
    interpolateEnvVars('${MISSING}', {}, logger);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('MISSING');
  });

  it('does not warn for resolved vars', () => {
    const warns: string[] = [];
    const logger = { info: () => {}, warn: (m: string) => warns.push(m), error: () => {} };
    interpolateEnvVars('${FOUND}', { FOUND: 'val' }, logger);
    expect(warns).toHaveLength(0);
  });
});

describe('interpolateConfigEnvVars', () => {
  it('resolves vars from config.env, not process.env', () => {
    const original = process.env.TEST_SECRET;
    process.env.TEST_SECRET = 'from-process';

    const config: McpServerConfig = {
      name: 'test',
      transport: {
        type: 'sse',
        url: 'https://example.com',
        headers: { Authorization: 'Bearer ${TEST_SECRET}' },
      },
      env: { TEST_SECRET: 'from-config' },
    };

    const result = interpolateConfigEnvVars(config);
    expect(result.transport.type === 'sse' && result.transport.headers?.Authorization).toBe(
      'Bearer from-config',
    );

    if (original === undefined) process.env.TEST_SECRET = undefined;
    else process.env.TEST_SECRET = original;
  });

  it('resolves to empty string when var not in config.env', () => {
    const config: McpServerConfig = {
      name: 'test',
      transport: { type: 'sse', url: 'https://${HOST}/api', headers: {} },
    };
    const result = interpolateConfigEnvVars(config);
    expect(result.transport.type === 'sse' && result.transport.url).toBe('https:///api');
  });
});

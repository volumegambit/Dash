import { interpolateEnvVars } from './env.js';

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
});

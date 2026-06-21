import { hookEnv, substituteVars } from './substitute.js';

describe('substituteVars', () => {
  const vars = { CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PLUGIN_DATA: '/d' };
  it('replaces ${VAR} from vars then process.env', () => {
    expect(substituteVars('${CLAUDE_PLUGIN_ROOT}/x', vars)).toBe('/p/x');
  });
  it('supports ${VAR:-default}', () => {
    expect(substituteVars('${MISSING:-fallback}', vars)).toBe('fallback');
  });
  it('reads from process.env when not in vars', () => {
    vi.stubEnv('DASH_SUB_T', 'envval');
    try {
      expect(substituteVars('${DASH_SUB_T}', vars)).toBe('envval');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('throws on an unknown var with no default', () => {
    expect(() => substituteVars('${NOPE_X}', vars)).toThrow(/NOPE_X/);
  });
});

describe('hookEnv', () => {
  it('merges vars over process.env', () => {
    const e = hookEnv({ CLAUDE_PLUGIN_ROOT: '/p' });
    expect(e.CLAUDE_PLUGIN_ROOT).toBe('/p');
    expect(e.PATH).toBe(process.env.PATH);
  });
});

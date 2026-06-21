import type {
  HookCommand,
  HookEvent,
  HookMatcherGroup,
  HooksConfig,
  PluginAuthor,
  PluginManifest,
} from './index.js';
import * as sdk from './index.js';

// Type-surface baseline: these names are a cross-plan contract (Plans 2–5
// import them verbatim). vitest erases types — the tuple is checked by
// `tsc --noEmit` via `npm run typecheck`.
// biome-ignore lint/suspicious/noExportsInTest: intentional — export forces tsc to check these types
export type TypeSurfaceBaseline = [
  PluginManifest,
  PluginAuthor,
  HookEvent,
  HookCommand,
  HookMatcherGroup,
  HooksConfig,
];

describe('@dash/plugin-sdk surface', () => {
  it('exports exactly the expected runtime names', () => {
    expect(Object.keys(sdk).sort()).toEqual(['PLUGIN_TYPES_VERSION']);
  });

  it('PluginManifest requires only name', () => {
    const m: PluginManifest = { name: 'demo' };
    expect(m.name).toBe('demo');
  });

  it('HooksConfig maps hook events to matcher groups', () => {
    const cfg: HooksConfig = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint', timeout: 5 }] }],
    };
    expect(cfg.PreToolUse?.[0].matcher).toBe('Bash');
    expect(cfg.SessionStart?.[0].hooks[0].command).toBe('echo hi');
  });
});

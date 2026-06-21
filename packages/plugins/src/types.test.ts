import type {
  LoadedPlugins,
  PluginEntryConfig,
  PluginFailure,
  PluginRecord,
  PluginStatus,
} from './index.js';

// biome-ignore lint/suspicious/noExportsInTest: intentional — export forces tsc to check these types
export type TypeSurfaceBaseline = [
  PluginStatus,
  PluginFailure,
  PluginRecord,
  LoadedPlugins,
  PluginEntryConfig,
];

describe('@dash/plugins host types', () => {
  it('PluginRecord composes status + skillDirs', () => {
    const r: PluginRecord = {
      name: 'demo',
      status: 'loaded',
      dir: '/x',
      skillDirs: ['/x/skills'],
      activated: ['skills'],
      noop: [],
    };
    expect(r.activated).toEqual(['skills']);
  });
});

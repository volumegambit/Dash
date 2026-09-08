import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReleaseVersion } from './check-release-version.mjs';

async function fixture(versions: {
  root: string;
  relay?: string;
  web?: string;
  ios?: string;
  plugin?: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dash-release-'));
  const write = async (rel: string, body: string) => {
    await mkdir(join(root, rel, '..'), { recursive: true });
    await writeFile(join(root, rel), body);
  };
  await write(
    'package.json',
    JSON.stringify({
      version: versions.root,
      workspaces: ['contracts/mobile/v1', 'packages/*', 'apps/*'],
    }),
  );
  await write('contracts/mobile/v1/package.json', JSON.stringify({ version: versions.root }));
  await write(
    'packages/relay/package.json',
    JSON.stringify({ version: versions.relay ?? versions.root }),
  );
  await write('apps/web/package.json', JSON.stringify({ version: versions.web ?? versions.root }));
  await mkdir(join(root, 'apps/homepage'), { recursive: true }); // workspace dir without a manifest
  await write(
    'packages/skills/plugins/demo/.claude-plugin/plugin.json',
    JSON.stringify({ version: versions.plugin ?? versions.root }),
  );
  await write(
    'ios/Config/Base.xcconfig',
    `#include "Other.xcconfig"\nMARKETING_VERSION = ${versions.ios ?? versions.root}\nCURRENT_PROJECT_VERSION = 1\n`,
  );
  return root;
}

describe('checkReleaseVersion', () => {
  let root: string;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('passes when the tag matches every recorded version', async () => {
    root = await fixture({ root: '1.2.3' });
    const result = await checkReleaseVersion({ root, ref: 'v1.2.3' });
    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.2.3');
    expect(result.mismatches).toEqual([]);
  });

  it('rejects a tag that differs from the root version', async () => {
    root = await fixture({ root: '1.2.3' });
    const result = await checkReleaseVersion({ root, ref: 'v1.2.4' });
    expect(result.ok).toBe(false);
    expect(result.expected).toBe('1.2.4');
    // Every file carries the root version, so every file disagrees with the tag.
    expect(result.mismatches).toHaveLength(6);
    expect(result.mismatches).toContainEqual({ file: 'package.json', version: '1.2.3' });
  });

  it('lists every workspace, plugin, and iOS file that drifted', async () => {
    root = await fixture({ root: '1.2.3', web: '0.0.1', ios: '1.2.2', plugin: '1.0.0' });
    const result = await checkReleaseVersion({ root, ref: 'v1.2.3' });
    expect(result.ok).toBe(false);
    expect(result.mismatches.map((m) => m.file).sort()).toEqual([
      'apps/web/package.json',
      'ios/Config/Base.xcconfig',
      'packages/skills/plugins/demo/.claude-plugin/plugin.json',
    ]);
  });

  it('rejects a ref that is not a v-prefixed semver tag', async () => {
    root = await fixture({ root: '1.2.3' });
    await expect(checkReleaseVersion({ root, ref: 'main' })).rejects.toThrow(/vX\.Y\.Z/);
  });
});

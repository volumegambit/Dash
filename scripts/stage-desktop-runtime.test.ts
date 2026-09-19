import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stageDesktopRuntime } from './stage-desktop-runtime.mjs';

describe('desktop release runtime', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dash-desktop-stage-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function put(path: string, content: string) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  it('stages a portable runtime with workspace links, plugin manifests and dependency assets', async () => {
    await put('package.json', '{"version":"0.3.1","type":"module"}');
    await put('apps/gateway/package.json', '{"name":"@dash/gateway","version":"0.3.1"}');
    await put('apps/gateway/dist/index.js', 'gateway');
    await put('apps/gateway/plugins/core/.claude-plugin/plugin.json', 'catalog');
    await put('apps/gateway/src/private.test.ts', 'do not ship');
    await put('node_modules/dependency/package.json', '{"name":"dependency"}');
    await put('node_modules/dependency/assets/theme.json', 'theme');
    await put('.env', 'do not ship');
    await mkdir(join(root, 'node_modules/@dash'), { recursive: true });
    await symlink('../../apps/gateway', join(root, 'node_modules/@dash/gateway'));
    const outputDir = join(root, 'release/runtime');
    await stageDesktopRuntime({
      projectRoot: root,
      outputDir,
      packagePaths: [
        root,
        join(root, 'node_modules/@dash/gateway'),
        join(root, 'node_modules/dependency'),
      ],
      nodeBinary: process.execPath,
    });
    expect(await readFile(join(outputDir, 'apps/gateway/dist/index.js'), 'utf8')).toBe('gateway');
    expect(
      await readFile(
        join(outputDir, 'apps/gateway/plugins/core/.claude-plugin/plugin.json'),
        'utf8',
      ),
    ).toBe('catalog');
    expect(
      await readFile(join(outputDir, 'node_modules/dependency/assets/theme.json'), 'utf8'),
    ).toBe('theme');
    expect(await readlink(join(outputDir, 'node_modules/@dash/gateway'))).toBe(
      '../../apps/gateway',
    );
    await expect(readFile(join(outputDir, '.env'))).rejects.toThrow();
    await expect(readFile(join(outputDir, 'apps/gateway/src/private.test.ts'))).rejects.toThrow();
    expect((await readFile(join(outputDir, 'runtime/bin/node'))).length).toBeGreaterThan(0);
  });
  it('rejects a package dependency outside the checkout', async () => {
    await put('package.json', '{"version":"0.3.1"}');
    await expect(
      stageDesktopRuntime({
        projectRoot: root,
        outputDir: join(root, 'release/runtime'),
        packagePaths: [dirname(root)],
        nodeBinary: process.execPath,
      }),
    ).rejects.toThrow('outside');
  });
});

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function inside(root, path) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error(`Runtime dependency is outside the checkout: ${path}`);
  }
  return rel;
}

/** Copy the installed production dependency closure without development source or secrets. */
export async function stageDesktopRuntime({ projectRoot, outputDir, packagePaths, nodeBinary }) {
  const requestedRoot = resolve(projectRoot);
  const outputRelative = inside(requestedRoot, resolve(outputDir));
  projectRoot = await realpath(projectRoot);
  outputDir = join(projectRoot, outputRelative);
  if (!inside(projectRoot, outputDir)) throw new Error('Cannot stage over the checkout');
  const paths = await Promise.all(
    packagePaths.map(async (path) => ({
      path: join(projectRoot, inside(requestedRoot, resolve(path))),
      real: await realpath(path),
    })),
  );
  for (const { path, real } of paths) {
    inside(projectRoot, path);
    inside(projectRoot, real);
  }
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await cp(join(projectRoot, 'package.json'), join(outputDir, 'package.json'));
  const copiedWorkspaces = new Set();
  for (const { path, real } of paths) {
    if (real === projectRoot) continue;
    const sourceRel = inside(projectRoot, real);
    const targetRel = inside(projectRoot, path);
    if (!sourceRel.split(/[\\/]/).includes('node_modules')) {
      const destination = join(outputDir, sourceRel);
      if (!copiedWorkspaces.has(real)) {
        await mkdir(destination, { recursive: true });
        await cp(join(real, 'package.json'), join(destination, 'package.json'));
        // All runtime workspace assets live in these directories. Preserve hidden plugin manifests.
        for (const asset of ['dist', 'plugins']) {
          try {
            await cp(join(real, asset), join(destination, asset), {
              recursive: true,
              verbatimSymlinks: true,
            });
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        copiedWorkspaces.add(real);
      }
      if (targetRel !== sourceRel) {
        const link = join(outputDir, targetRel);
        await mkdir(dirname(link), { recursive: true });
        await symlink(relative(dirname(link), destination), link, 'junction');
      }
    } else {
      const destination = join(outputDir, targetRel);
      await mkdir(dirname(destination), { recursive: true });
      await cp(real, destination, { recursive: true, verbatimSymlinks: true });
    }
  }
  const binary = join(outputDir, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  await mkdir(dirname(binary), { recursive: true });
  await cp(nodeBinary, binary);
  await cp(join(dirname(nodeBinary), '../LICENSE'), join(outputDir, 'runtime/LICENSE'));
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22)
    throw new Error('Packaging requires Node.js 22+');
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const staging = join(projectRoot, 'apps/mission-control/release/staging');
  const packagePaths = execFileSync(
    'npm',
    [
      'ls',
      '--workspace=@dash/gateway',
      '--workspace=@dash/mission-control',
      '--omit=dev',
      '--all',
      '--parseable',
    ],
    { cwd: projectRoot, encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  await stageDesktopRuntime({
    projectRoot,
    outputDir: join(staging, 'runtime'),
    packagePaths,
    nodeBinary: process.execPath,
  });
  const desktop = join(projectRoot, 'apps/mission-control');
  const app = join(staging, 'app');
  await rm(app, { recursive: true, force: true });
  await mkdir(app, { recursive: true });
  await cp(join(desktop, 'out'), join(app, 'out'), { recursive: true });
  const manifest = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
  // Dependencies are already in Resources/node_modules. Avoid electron-builder pruning the workspace
  // or rebuilding gateway native addons against Electron's different Node ABI.
  await writeFile(
    join(app, 'package.json'),
    `${JSON.stringify({ name: manifest.name, version: manifest.version, main: manifest.main }, null, 2)}\n`,
  );
  await writeFile(
    join(staging, 'runtime/release.json'),
    `${JSON.stringify({ version: manifest.version, platform: process.platform, arch: process.arch, node: process.versions.node }, null, 2)}\n`,
  );
  console.log(
    `Staged ${packagePaths.length} dependency paths for ${manifest.version} (${process.platform}/${process.arch}, Node ${process.versions.node})`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

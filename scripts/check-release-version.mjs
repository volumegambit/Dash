#!/usr/bin/env node
// A release tag must agree with every version recorded in the tree: the root
// package.json (source of truth), every workspace manifest, every bundled
// plugin manifest, and the iOS MARKETING_VERSION. `npm run version:sync`
// writes all of them; this script proves it was run before the tag was cut.
//
//   node scripts/check-release-version.mjs v1.2.3
//   node scripts/check-release-version.mjs            # uses $GITHUB_REF_NAME
import { realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Expand a workspace pattern (`apps/*` or a literal path) into directories. */
async function expandWorkspace(root, pattern) {
  if (!pattern.endsWith('/*')) return [join(root, pattern)];
  const parent = join(root, pattern.slice(0, -2));
  if (!(await exists(parent))) return [];
  const entries = await readdir(parent, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => join(parent, e.name));
}

async function pluginManifests(root) {
  const pluginsDir = join(root, 'packages/skills/plugins');
  if (!(await exists(pluginsDir))) return [];
  const entries = await readdir(pluginsDir, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = join(pluginsDir, entry.name, '.claude-plugin/plugin.json');
    if (await exists(manifest)) manifests.push(manifest);
  }
  return manifests;
}

/** Every file that carries the release version, with the version it records. */
export async function collectVersions(root) {
  const rootManifest = await readJson(join(root, 'package.json'));
  const files = [{ file: 'package.json', version: String(rootManifest.version) }];

  for (const pattern of rootManifest.workspaces ?? []) {
    for (const dir of await expandWorkspace(root, pattern)) {
      const manifest = join(dir, 'package.json');
      if (!(await exists(manifest))) continue; // e.g. apps/homepage, an empty workspace dir
      files.push({
        file: relative(root, manifest),
        version: String((await readJson(manifest)).version),
      });
    }
  }

  for (const manifest of await pluginManifests(root)) {
    files.push({
      file: relative(root, manifest),
      version: String((await readJson(manifest)).version),
    });
  }

  const xcconfig = join(root, 'ios/Config/Base.xcconfig');
  if (await exists(xcconfig)) {
    const match = (await readFile(xcconfig, 'utf8')).match(/^MARKETING_VERSION\s*=\s*(\S+)\s*$/m);
    files.push({ file: 'ios/Config/Base.xcconfig', version: match ? match[1] : '(missing)' });
  }

  return files;
}

export async function checkReleaseVersion({ root, ref }) {
  const match = TAG_PATTERN.exec(ref ?? '');
  if (!match) {
    throw new Error(`Release ref must look like vX.Y.Z (got ${JSON.stringify(ref ?? '')})`);
  }
  const expected = match[1];
  const files = await collectVersions(root);
  const mismatches = files.filter((entry) => entry.version !== expected);
  return { ok: mismatches.length === 0, version: files[0].version, expected, mismatches };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);

if (invokedDirectly) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const ref = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  const result = await checkReleaseVersion({ root, ref });
  if (result.ok) {
    console.log(`release version ${result.expected}: every version file agrees`);
  } else {
    console.error(`release ref ${ref} expects ${result.expected}, but these files disagree:`);
    for (const { file, version } of result.mismatches) console.error(`  ${file}: ${version}`);
    console.error('run `npm run version:sync` and commit before tagging');
    process.exit(1);
  }
}

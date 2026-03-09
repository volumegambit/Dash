#!/usr/bin/env node
// scripts/download-opencode.mjs
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const OPENCODE_VERSION = '1.2.22';

const PLATFORM_MAP = {
  darwin: 'darwin',
  win32: 'windows',
};

const ARCH_MAP = {
  arm64: 'arm64',
  x64: 'x64',
};

const platform = process.env.TARGET_PLATFORM ?? PLATFORM_MAP[process.platform];
const arch = process.env.TARGET_ARCH ?? ARCH_MAP[process.arch];

if (!platform) throw new Error(`Unsupported platform: ${process.platform}`);
if (!arch) throw new Error(`Unsupported arch: ${process.arch}`);

const binaryName = platform === 'windows' ? 'opencode.exe' : 'opencode';
const zipName = `opencode-${platform}-${arch}.zip`;
const downloadUrl = `https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/${zipName}`;

const outDir = join(import.meta.dirname, '../apps/mission-control/build/bin');
const binaryPath = join(outDir, binaryName);
const versionPath = join(outDir, '.version');

// Skip if already downloaded at correct version
if (existsSync(versionPath) && readFileSync(versionPath, 'utf-8').trim() === OPENCODE_VERSION) {
  console.log(`opencode ${OPENCODE_VERSION} already downloaded, skipping.`);
  process.exit(0);
}

console.log(`Downloading opencode ${OPENCODE_VERSION} for ${platform}-${arch}...`);
console.log(`URL: ${downloadUrl}`);

await mkdir(outDir, { recursive: true });

// Download zip
const zipPath = join(outDir, zipName);
const response = await fetch(downloadUrl);
if (!response.ok) {
  throw new Error(`Download failed: ${response.status} ${response.statusText}\nURL: ${downloadUrl}`);
}
await pipeline(response.body, createWriteStream(zipPath));

// Extract using unzip (macOS/Linux) or Expand-Archive (Windows)
const { execFileSync } = await import('node:child_process');
if (platform === 'windows') {
  execFileSync('powershell', [
    '-Command',
    `Expand-Archive -Force -Path "${zipPath}" -DestinationPath "${outDir}"`,
  ]);
} else {
  execFileSync('unzip', ['-o', zipPath, '-d', outDir]);
}

await rm(zipPath);

if (platform !== 'windows') {
  await chmod(binaryPath, 0o755);
}

writeFileSync(versionPath, OPENCODE_VERSION);
console.log(`opencode ${OPENCODE_VERSION} downloaded to ${binaryPath}`);

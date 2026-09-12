#!/usr/bin/env node
// Cloudflare Pages serves headers from a `_headers` file in the deployed
// directory. apps/web declares its Content-Security-Policy as a <meta> tag in
// index.html (guarded by apps/web/src/csp.test.ts); the README asks for the
// same policy as a real header so an intermediary can't strip it. This reads
// the policy out of the BUILT index.html — after Vite has interpolated the
// VITE_* origins — so the header can never drift from the tag.
//
//   node scripts/web-csp-headers.mjs apps/web/dist
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const META_PATTERN = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/i;

export function extractCsp(html) {
  const match = META_PATTERN.exec(html);
  if (!match) throw new Error('index.html has no Content-Security-Policy <meta> tag');
  return match[1].replace(/\s+/g, ' ').trim();
}

export function renderHeaders(csp) {
  return [
    '/*',
    `  Content-Security-Policy: ${csp}`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '',
  ].join('\n');
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);

if (invokedDirectly) {
  const dist = process.argv[2];
  if (!dist) {
    console.error('usage: node scripts/web-csp-headers.mjs <dist-dir>');
    process.exit(2);
  }
  const html = await readFile(join(dist, 'index.html'), 'utf8');
  const target = join(dist, '_headers');
  await writeFile(target, renderHeaders(extractCsp(html)));
  console.log(`wrote ${target}`);
}

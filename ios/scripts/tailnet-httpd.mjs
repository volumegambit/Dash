#!/usr/bin/env node
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';

const [directoryArg, portArg = '8787'] = process.argv.slice(2);

if (!directoryArg) {
  console.error('usage: tailnet-httpd.mjs <directory> [port]');
  process.exit(2);
}

const root = resolve(directoryArg);
const port = Number(portArg);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`invalid port: ${portArg}`);
  process.exit(2);
}

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.ipa', 'application/octet-stream'],
  ['.plist', 'application/xml; charset=utf-8'],
]);

function fileFor(url) {
  const pathname = new URL(url ?? '/', 'http://127.0.0.1').pathname;
  const name = basename(pathname) || 'index.html';
  const candidate = normalize(join(root, name));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

const server = createServer((request, response) => {
  const file = fileFor(request.url);
  if (!file) {
    response.writeHead(400).end('bad request');
    return;
  }

  let stats;
  try {
    stats = statSync(file);
  } catch {
    response.writeHead(404).end('not found');
    return;
  }

  if (!stats.isFile()) {
    response.writeHead(404).end('not found');
    return;
  }

  response.writeHead(200, {
    'Content-Length': stats.size,
    'Content-Type': mimeTypes.get(extname(file)) ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  createReadStream(file).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}`);
});

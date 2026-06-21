// Writes the raw stdin payload it received to a file path taken from argv[2]
// (or the ECHO_STDIN_OUT env var) so a test can assert the exact Claude Code
// stdin shape. Exits 0 with no decision.
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? process.env.ECHO_STDIN_OUT;
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8');
  if (out) writeFileSync(out, raw);
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));

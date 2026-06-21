// Reads stdin, emits nothing, exits 0 → no decision (allow / fail-open neutral).
import { readStdin } from './_read-stdin.js';

await readStdin();
process.exit(0);

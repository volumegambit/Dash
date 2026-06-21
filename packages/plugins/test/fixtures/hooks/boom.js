// Non-blocking error: exit 1. The engine must fail-open (no block/modify) and
// log a warning.
import { readStdin } from './_read-stdin.js';

await readStdin();
process.exit(1);

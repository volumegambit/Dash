// Sleeps longer than the test timeout so the engine must KILL it and fail-open.
import { readStdin } from './_read-stdin.js';

await readStdin();
setTimeout(() => process.exit(0), 2000);

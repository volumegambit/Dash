// Blocking error: exit 2 with a stderr message. The engine maps exit 2 to a
// block whose reason is the stderr text.
import { readStdin } from './_read-stdin.js';

await readStdin();
process.stderr.write('blocked by block2');
process.exit(2);

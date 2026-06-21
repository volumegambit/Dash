// PreToolUse modify: echoes back the received tool_input with an extra marker
// field so a test can assert threading. Prints updatedInput, exits 0.
import { readStdin } from './_read-stdin.js';

const event = await readStdin();
const base =
  event && typeof event.tool_input === 'object' && event.tool_input !== null
    ? event.tool_input
    : {};
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...base, modified: true },
    },
  }),
);
process.exit(0);

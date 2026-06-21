// PreToolUse deny: prints a hookSpecificOutput with permissionDecision=deny,
// exits 0. The engine maps this to { block: true, reason: 'nope' }.
import { readStdin } from './_read-stdin.js';

await readStdin();
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'nope',
    },
  }),
);
process.exit(0);

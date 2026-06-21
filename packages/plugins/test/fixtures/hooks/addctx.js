// Emits additionalContext for PostToolUse / UserPromptSubmit / lifecycle.
// The context string can be overridden via argv[2] so two instances can emit
// distinct strings (to assert concatenation). Exits 0.
import { readStdin } from './_read-stdin.js';

const event = await readStdin();
const ctx = process.argv[2] ?? 'ctx';
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event.hook_event_name ?? 'PostToolUse',
      additionalContext: ctx,
    },
  }),
);
process.exit(0);

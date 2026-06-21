// UserPromptSubmit / Stop / PostToolUse block via the TOP-LEVEL `decision`
// field: { "decision": "block", "reason": "..." } (exit 0, no hookSpecificOutput).
// The engine maps this to { block: true, reason }.
import { readStdin } from './_read-stdin.js';

await readStdin();
process.stdout.write(JSON.stringify({ decision: 'block', reason: 'top-level block' }));
process.exit(0);

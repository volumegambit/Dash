// Emits a single burst of stdout larger than the engine's output cap
// (MAX_HOOK_OUTPUT_BYTES, 4 MB), then idles. The engine must detect the cap on
// the buffered chunks, KILL the child, and fail-open (NEUTRAL) rather than
// buffering unboundedly (OOM) or hanging until the timeout. Ignores stdin.
// A single burst (vs continuous flooding) crosses the cap immediately while
// keeping CPU/IO load low so it does not starve sibling tests under parallel
// vitest workers. A keep-alive timer holds the event loop open until the
// parent's SIGKILL arrives.
const FIVE_MB = 5 * 1024 * 1024; // comfortably past the 4 MB cap.
process.stdout.write('x'.repeat(FIVE_MB));
setInterval(() => {}, 1000); // stay alive; never exit on our own.

// Ignores stdin entirely (never reads it), emits valid JSON, exits 0.
// Used to exercise the >64KB-undrained-stdin path: when the engine writes a
// large payload to a child that doesn't drain stdin, the pending write emits
// an async EPIPE on child.stdin once the child exits. The engine must swallow
// that error and fail-open (NEUTRAL), not crash the host process.
process.stdout.write(JSON.stringify({}));
process.exit(0);

// Ignores stdin and sleeps past the engine timeout so the engine must KILL it
// (SIGKILL) while a large stdin write is still pending. The SIGKILL closes the
// read end of the pipe, producing an async EPIPE on child.stdin that the engine
// must swallow and fail-open, not escalate to uncaughtException.
setTimeout(() => process.exit(0), 5000);

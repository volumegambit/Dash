---
name: systematic-debugging
description: A disciplined root-cause workflow (reproduce, isolate, hypothesize, verify, fix, confirm) for a bug, test failure, or unexpected behavior — use whenever the user reports something broken or asks you to debug.
tags: [dev, debugging, testing]
---

# Systematic Debugging

## When to use
The user reports a bug, a failing test, a crash, an error message, or behavior that does not match expectations — and asks you to find and fix the cause. Use this instead of guessing-and-patching, especially when the cause is not obvious or a previous quick fix did not hold.

## Workflow
1. Pin down the symptom. Establish exactly what is wrong: the expected behavior, the actual behavior, the exact error text or failing assertion, and where it was observed. Ask the user for the precise command, input, or repro steps if you do not have them.
2. Reproduce it first. Run the failing command yourself with `bash` (e.g. the test runner, the script, the build). Do not attempt a fix until you have seen the failure with your own eyes. If you cannot reproduce it, that is the first problem to solve — gather more context (environment, config, inputs) before proceeding.
3. Read the full evidence. Read the complete stack trace or error output top to bottom, not just the last line. Use `read` to open every file named in the trace at the referenced lines. Use `grep` to locate the error message string in the source to find where it originates.
4. Isolate the failure. Narrow the surface area: identify the smallest input or code path that triggers it. Use `git log` and `git diff` to check what changed recently around the failing area — a regression usually points at a recent commit. Add temporary logging or assertions with `edit` if needed to observe intermediate state, and re-run.
5. Form a single hypothesis. State one specific, testable theory of the root cause ("X is null because Y is never assigned when Z"). Distinguish the root cause from the symptom — fix the cause, not the place the error surfaced.
6. Verify the hypothesis before fixing. Confirm the theory with evidence (a log value, a focused test, a `grep` showing the missing call) so you are not patching blind. If the evidence contradicts the hypothesis, return to step 5 with a new one.
7. Apply the minimal fix. Use `edit` to make the smallest change that addresses the root cause. Avoid unrelated refactors. Remove any temporary debug logging you added.
8. Confirm the fix. Re-run the original failing repro from step 2 and confirm it now passes. Then run the broader test suite with `bash` to ensure no regression. Use `todowrite` to track multiple sub-issues if the bug has several causes.

## Output
Report in this structure:
- **Symptom** — what was observed (with the error text).
- **Root cause** — the actual underlying defect and why it produced the symptom.
- **Evidence** — what confirmed the cause (`file:line`, log output, failing test).
- **Fix** — what you changed and why it resolves the cause.
- **Verification** — the commands you ran and their now-passing results.

## Guardrails
- Never claim a bug is fixed without re-running the repro and showing it passes — evidence before assertions.
- Do not apply speculative fixes hoping one works; isolate the cause first.
- Do not suppress or work around the symptom (catch-and-ignore, loosened assertions, retries) when the real cause is reachable.
- Keep changes minimal and scoped to the bug; flag unrelated issues you notice separately rather than fixing them inline.
- If after reasonable investigation the cause is still unclear, report your findings and the narrowed-down candidates rather than forcing a guess.

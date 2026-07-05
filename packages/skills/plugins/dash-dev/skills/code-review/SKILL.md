---
name: code-review
description: Review a code diff, branch, or pull request for correctness, security, and clarity issues — use whenever the user asks you to review code, a diff, a PR, or changes before merging.
tags: [dev, review, git, security]
---

# Code Review

## When to use
The user asks you to review code, a diff, a branch, or a pull request — phrasings like "review this", "look over my changes", "review PR #42", or "is this safe to merge?". Use this before merging or when a second opinion on a change is wanted.

## Workflow
1. Determine the review scope. Ask the user only if it is ambiguous; otherwise infer:
   - Working-tree changes: `git diff` (unstaged) and `git diff --staged` (staged).
   - A branch vs. its base: `git diff main...HEAD` (replace `main` with the actual base).
   - A specific PR: `gh pr diff <number>` if the `gh` CLI is available; otherwise ask the user to paste the diff or branch name.
2. Get context before judging. Run `git log --oneline -10` to see recent history and the change's intent. Use `read` on each changed file to view surrounding code, not just the diff hunks — a line can look fine in isolation and be wrong in context.
3. Trace ripple effects. For each changed function, type, or exported symbol, use `grep` to find its callers and other usages. Confirm the change is consistent everywhere it is used and that no caller was missed.
4. Review each hunk against these dimensions, in priority order:
   - **Correctness**: logic errors, off-by-one, wrong conditionals, unhandled null/undefined, broken edge cases, race conditions, incorrect async/await or unawaited promises, resource leaks.
   - **Security**: injection (SQL/shell/command), missing input validation, secrets or credentials in code, path traversal, unsafe deserialization, missing authz/authn checks, sensitive data in logs.
   - **Error handling**: swallowed errors, missing error paths, throwing where the codebase expects an error result/event (check project conventions).
   - **Clarity & maintainability**: confusing names, dead code, duplicated logic, missing or misleading comments, overly complex constructs.
   - **Tests**: are new code paths and edge cases covered? Is a regression test missing for a bug fix?
5. Verify against project conventions. Read any `CLAUDE.md`, `AGENTS.md`, or contributing docs and check the change follows the established error-handling, naming, and import patterns.
6. Do not edit files. This skill reviews and reports only. If the user wants fixes applied, confirm first, then make them as a separate step.

## Output
Group findings by severity and reference exact locations:
- **Blocking** — must fix before merge (correctness, security).
- **Should fix** — important but not strictly blocking.
- **Nitpick** — optional polish.

For each finding, give `file:line`, a one-line description of the problem, why it matters, and a concrete suggested fix. End with a one-line overall verdict (approve / approve with changes / request changes). If you found nothing wrong in a dimension, say so briefly rather than padding.

## Guardrails
- Never approve code you could not actually read — if you only have a partial diff, say what you could not assess.
- Do not speculate about runtime behavior you cannot verify; mark uncertain findings as "verify:" rather than asserting them.
- Do not run tests, builds, or any command that mutates state as part of a review unless the user explicitly asks.
- If the scope is unclear (which branch, which base, which PR), ask one focused question before diffing.
- Keep nitpicks brief and clearly separated from real issues so they do not drown the signal.

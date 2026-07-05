---
name: pr-workflow
description: Take a finished change from working tree to a well-described pull request — branch, commit, push, and open the PR with linked issues — use when the user asks to open/create a PR or ship a change.
tags: [dev, git, github, pr]
---

# PR Workflow

## When to use
The user asks to open or create a pull request, "ship this", "put this up for review", or otherwise wants completed local changes turned into a reviewable PR. Use when the work is in a complete, working state and ready to be proposed for merge.

## Workflow
1. Inspect the current state. Run `git status` and `git diff` (and `git diff --staged`) to see exactly what changed. Confirm the work is complete and not mid-edit — do not open a PR for broken or half-finished changes.
2. Pick the base branch. Run `git branch --show-current` and `git rev-parse --abbrev-ref HEAD`. Determine the integration target (usually `main`). If changes are already on `main`, create a feature branch first: `git switch -c <type>/<short-description>` (e.g. `fix/null-session-id`).
3. Run local checks before committing, if the project defines them. Look in `package.json`/`CLAUDE.md` for lint, build, and test commands and run them with `bash`. Do not push code that fails them.
4. Stage precisely. Stage only the files that belong to this change with `git add <file> ...`. Never use `git add -A` or `git add .` — review each path. Keep unrelated edits out of the PR.
5. Commit with a clear message. Write a concise, conventional summary line (e.g. `fix: handle missing session id`) plus a body explaining the what and why. Follow any commit conventions in `CLAUDE.md` (e.g. whether `Co-Authored-By` lines are wanted). Use `git commit`.
6. Push the branch: `git push -u origin <branch>`.
7. Link related issues. If the change addresses a tracked issue, use the `projects_*` tools to find the issue (Linear/GitHub) and capture its identifier so it can be referenced and auto-closed (e.g. `Closes #123` or the Linear magic word). If no issue exists and the change is substantial, offer to create one with `projects_*`.
8. Open the PR with `gh pr create`. Provide a title matching the commit summary and a body covering: **Summary** (what changed and why), **Changes** (bullet list of notable edits), **Testing** (what you ran and the result), and **Linked issues**. Target the base branch from step 2.
9. Report the PR URL returned by `gh`.

## Output
A short report containing:
- The branch name and base.
- The commit summary line(s).
- The PR title and URL.
- Which issues are linked/closed.
- The result of any lint/build/test checks you ran.

## Guardrails
- Never commit or push without the user's intent to ship; this skill is invoked precisely for that, but still pause if checks fail.
- Stage only the specific files you intend to ship — confirm with `git status` that nothing unexpected is included.
- Do not commit secrets, credentials, or local config; scan the diff for them before committing.
- If `gh` is not installed or not authenticated, stop and tell the user how to proceed (push is done; PR must be opened manually or `gh auth login` run).
- If lint/build/test fail, do not open the PR — report the failures and ask whether to fix them first.
- If the base branch or issue link is ambiguous, ask one focused question before pushing.

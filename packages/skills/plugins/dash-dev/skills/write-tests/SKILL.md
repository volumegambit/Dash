---
name: write-tests
description: Author focused, behavior-driven tests for given code — clear names, meaningful edge cases, and a passing run — use when the user asks to write, add, or improve tests for a function, module, or feature.
tags: [dev, testing]
---

# Write Tests

## When to use
The user asks you to write, add, or improve tests for specific code — a function, class, module, endpoint, or feature. Use when new behavior needs coverage, a bug fix needs a regression test, or existing tests are thin.

## Workflow
1. Read the code under test. Use `read` on the target file(s) to understand the public behavior, inputs, outputs, side effects, and error paths. Test the observable behavior and contract, not private implementation details.
2. Learn the project's test setup. Find the test runner and conventions: check `package.json` scripts, config files (e.g. `vitest.config`, `jest.config`, `pytest.ini`), and an existing nearby `*.test.*` file. Match the framework, file location, naming pattern, assertion style, and setup/teardown idioms already in use. Reuse existing fixtures and helpers — do not invent a new style.
3. Enumerate cases before writing. List what to cover: the happy path, each meaningful branch, boundary values (empty, zero, one, max), invalid input, error/exception paths, and any concurrency or async behavior. For a bug fix, include a test that fails on the old behavior and passes on the fix.
4. Write the tests with `write` (new file) or `edit` (extend existing). Each test:
   - Has a descriptive name stating the behavior and condition (e.g. `returns empty list when input is empty`, not `test1`).
   - Follows arrange / act / assert with a single clear behavior per test.
   - Uses precise assertions on the actual contract, not loose truthiness.
   - Is deterministic — no reliance on real time, network, randomness, or ordering; use the project's fakes/mocks for those, following existing patterns. Prefer real objects over mocks when practical.
   - Cleans up resources it creates (temp dirs, files) in teardown, matching project idioms.
5. Run the tests with `bash` using the project's runner (e.g. `npm test`, `npx vitest run <path>`, `pytest <path>`). Confirm they pass.
6. Confirm the tests are meaningful, not vacuous. Ensure a test would actually fail if the behavior broke — for a regression test, this means it fails against the buggy code. Fix any flaky or trivially-true tests.

## Output
A short report with:
- The test file path(s) created or modified.
- A list of the behaviors and edge cases now covered.
- The exact command to run them and the passing result (counts).
- Any behavior you intentionally did not cover and why, or gaps that need a follow-up.

## Guardrails
- Do not test private internals or restate the implementation; if a test only passes because it mirrors the code line-for-line, it is not useful.
- Do not write tests that always pass regardless of behavior — verify each one can fail.
- Do not change the code under test to make a test pass unless the user asked you to fix a bug; if a test reveals a real defect, report it.
- Avoid over-mocking — mock only true external boundaries (network, clock, filesystem when required), following existing project patterns.
- If the testing framework or where tests should live is unclear, ask one focused question before writing.

Audit all user documentation in `docs/` for accuracy, dead links, and quality. Fix all issues found.

## What to check

### 1. Dead links
Check every internal link in all `docs/*.mdx` files. Valid page slugs are determined by filenames in `docs/` (without the `.mdx` extension). Also check `docs/docs.json` to ensure every page listed in navigation exists as a file.

### 2. Tool names
The canonical tool names are defined in `apps/mission-control/src/renderer/src/components/deploy-options.ts` (`AVAILABLE_TOOLS`). Check all docs for stale tool names (e.g. `read_file` instead of `read`).

### 3. Model names and format
Config examples must use the `provider/model` format (e.g. `anthropic/claude-sonnet-4-20250514`). Check `apps/mission-control/src/renderer/src/components/deploy-options.ts` (`AVAILABLE_MODELS`) for the current model list. Check `apps/dash/src/config.ts` for the actual default model.

### 4. Configuration accuracy
Cross-reference config fields documented in `configuration.mdx` and `agents.mdx` against the actual types in `packages/mc/src/types.ts` (`AgentDeployAgentConfig`, `DeployConfig`) and `apps/dash/src/config.ts`.

### 5. API endpoints
Cross-reference `api-reference.mdx` against actual endpoints in `packages/management/src/server.ts`.

### 6. Feature accuracy
Check that features described in docs (Mission Control UI, CLI commands, skills, etc.) match the current codebase. Key source files:
- MC routes: `apps/mission-control/src/renderer/src/routes/`
- Skills: `packages/agent/src/skills/`
- Tools: `packages/agent/src/tools/` or `packages/agent/src/backends/piagent.ts`

### 7. Duplication
Flag content that is repeated across multiple pages and should be consolidated or cross-linked instead.

### 8. Quality
Flag awkward phrasing, jargon in user-facing pages, or inconsistent tone.

## How to run

1. List all `.mdx` files in `docs/` to discover every page dynamically
2. Read `docs/docs.json` to get the navigation structure and groups
3. Split the discovered pages into ~4 equal batches
4. Dispatch 4 parallel Explore agents, one per batch, each reviewing its assigned pages against the checks above

## Output

For each issue found, report:
- File and line number
- Severity: Critical (wrong info users will copy), Important (should fix), Minor (polish)
- What's wrong and how to fix it

After reporting, fix all Critical and Important issues directly. Commit with message: `fix(docs): audit — [summary of fixes]`

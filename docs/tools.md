# Tools

Dash agents can use tools to interact with the system. Tools are enabled per-agent via the `tools` array in `config/dash.json`.

## Available tools

### `bash`

Executes a shell command and returns its output.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | `string` | yes | The shell command to execute |

**Limits:**

- **Timeout**: 30 seconds — commands that exceed this are killed
- **Output size**: 100 KB — output beyond this limit is truncated

When a workspace is configured, `bash` sets its working directory (`cwd`) to the workspace path. Commands still have access to the full system; the workspace only sets the starting directory.

**Example interaction:**

```
User: List the files in the workspace
Agent: [bash] ls -la
→ total 24
  drwxr-xr-x  4 user  staff  128 Jan 15 10:00 .
  -rw-r--r--  1 user  staff  256 Jan 15 10:00 notes.md
```

### `read_file`

Reads the contents of a file and returns it as text.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | File path to read |

**Limits:**

- **File size**: 500 KB — files larger than this are truncated with a `(truncated at 500KB)` notice

When a workspace is configured, paths are resolved relative to the workspace directory. Path traversal outside the workspace (e.g. `../../etc/passwd`) is blocked — the tool validates that the resolved real path stays within the workspace boundary.

## Workspace sandboxing

The `workspace` field in an agent's config sets a directory that tools operate within:

```json
{
  "agents": {
    "default": {
      "workspace": "./data/workspace"
    }
  }
}
```

The workspace path is resolved relative to the project root. The directory is created automatically if it doesn't exist.

**How sandboxing works per tool:**

- **`bash`**: The workspace is set as the working directory (`cwd`). The command itself is not sandboxed — it can still access other paths if given absolute paths.
- **`read_file`**: Paths are resolved relative to the workspace. The tool uses `realpath()` to check that the final resolved path stays within the workspace. Symlinks that escape the workspace are blocked.

If no workspace is configured, tools operate without path restrictions — `bash` runs in the default directory and `read_file` accepts any absolute path.

## Tool registration

Tools are registered via a factory map in `packages/agent/src/tools/index.ts`. The `resolveTools()` function maps tool name strings from the config to `Tool` instances:

```
config: ["bash", "read_file"]
  → resolveTools(names, workspace)
  → [BashTool, ReadFileTool]
```

Each tool implements the `Tool` interface:

```typescript
interface Tool {
  name: string;
  definition: ToolDefinition;  // JSON schema for the LLM
  execute(input: Record<string, unknown>): Promise<ToolExecutionResult>;
}
```

An unknown tool name in the config causes a startup error listing the available tools.

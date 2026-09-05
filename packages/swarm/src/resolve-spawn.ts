/**
 * Spawn resolution (design §6.4 steps 2-4): the pure functions that turn a
 * sub-agent DEFINITION plus the PARENT's effective capabilities into the exact
 * grant a child is spawned with — tools, MCP tools, spawnable types, model,
 * and preloaded skill bodies.
 *
 * The security property of the whole sub-agent feature lives here: a child can
 * never hold a tool or an MCP server its parent lacks. Every path below is an
 * INTERSECTION with the parent's sets, never a union, so escalation is not
 * expressible rather than merely unlikely. `SwarmCoordinator.validateTools` /
 * `validateMcpTools` re-check the result as defence in depth (the legacy
 * `spawn_worker` tool reaches the coordinator without passing through here).
 */

/** The full universe of built-in tools a child may ever be granted. */
export const UNIVERSE = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
  'web_fetch',
  'web_search',
] as const;

/**
 * The tools an orchestrator has by default (when `config.tools` is unset).
 * Mirrors `DEFAULT_TOOL_NAMES` in `packages/agent/src/backends/piagent.ts` —
 * the list pi activates when the agent config names none.
 */
export const DEFAULT_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;

/**
 * Tools every agent holds regardless of `config.tools`, so a child inheriting
 * them is not an escalation. `PiAgentBackend.buildCustomTools` registers the
 * task tracker unconditionally and `load_skill` whenever the agent has skill
 * paths (the gateway always gives it some).
 *
 * NOTE ON NAMING: the design calls the task tracker `todowrite` (Claude Code's
 * name). Dash's tool is literally named `task` (`createTodoWriteTool`), and
 * this list must carry the name the child's backend will actually register, or
 * the roster would advertise a tool that does not exist.
 */
export const ALWAYS_AVAILABLE_TOOLS = ['load_skill', 'task'] as const;

/** The parent's effective capabilities at the moment of a spawn. */
export interface ParentToolContext {
  /** Parent's effective built-ins (incl. web) + `load_skill` + the task tool. */
  builtinTools: string[];
  /** Fully-qualified `server__tool` names the parent holds. */
  mcpTools: string[];
  /** The parent's own depth: 0 for a top-level orchestrator. */
  depth: number;
  /** How deep this orchestrator's descendants may nest. */
  maxDepth: number;
}

/** What one definition resolves to against one parent. */
export interface ResolvedChildTools {
  /** Built-in tool names, in the order the definition (or parent) lists them. */
  tools: string[];
  /** Fully-qualified `server__tool` names. */
  mcpTools: string[];
  /** `agent(a, b)` — the types this child may itself spawn. Unset = all. */
  spawnableTypes?: string[];
  /** Whether the child gets `agent` / `send_message` at all. */
  canSpawn: boolean;
}

/** A definition, narrowed to the fields tool resolution reads. */
export interface ChildToolRequest {
  tools?: string[];
  disallowedTools?: string[];
  /** Definition-level `agent(a, b)` restriction is expressed via `tools`. */
}

export interface ResolveChildModelInput {
  /** Per-call `model` from the `agent` tool. */
  requested?: string;
  /** Definition-level `model:`. */
  definition?: string;
  parentModel: string;
  aliases: Record<string, string>;
}

/** `agent`, `agent()`, `agent(Explore)`, `agent(Explore, Plan)`. */
const AGENT_ENTRY_RE = /^agent(?:\(([^()]*)\))?$/;
const MCP_PREFIX = 'mcp__';

/**
 * Whether an `mcp__…` pattern selects a fully-qualified `server__tool` name.
 *
 * - `mcp__*` — every MCP tool the parent holds.
 * - `mcp__X` — every tool of server `X`.
 * - `mcp__X__Y` — exactly that tool.
 */
function mcpPatternMatches(pattern: string, qualified: string): boolean {
  if (!pattern.startsWith(MCP_PREFIX)) return false;
  const rest = pattern.slice(MCP_PREFIX.length);
  if (rest === '' || rest === '*') return true;
  if (rest === qualified) return true;
  return qualified.startsWith(`${rest}__`);
}

function zeroToolsError(entries: string[]): Error {
  const detail = entries.length
    ? entries.join(', ')
    : 'nothing in the definition resolved to a tool the parent holds';
  return new Error(`Agent would be spawned with zero tools: ${detail}`);
}

/**
 * The canonical `ParentToolContext.builtinTools` for an agent whose config
 * lists `configTools` (`undefined` = the default grant).
 *
 * Both sides of the spawn read this ONE function — the `agent` tool builds the
 * parent context with it and `SwarmCoordinator.validateTools` bounds the child
 * request with it — so what the roster advertises, what the child is granted,
 * and what the coordinator accepts cannot drift.
 *
 * Anything outside {@link UNIVERSE} is dropped: skill-management (`create_skill`,
 * `install_skill`, `remove_skill`) and MCP-management tools are parent-only and
 * are never inheritable, however the operator configured the parent.
 */
export function parentBuiltinTools(configTools?: string[]): string[] {
  const universe = new Set<string>(UNIVERSE);
  const out: string[] = [];
  for (const tool of configTools ?? DEFAULT_TOOL_NAMES) {
    if (!universe.has(tool) && !(ALWAYS_AVAILABLE_TOOLS as readonly string[]).includes(tool)) {
      continue;
    }
    if (!out.includes(tool)) out.push(tool);
  }
  for (const tool of ALWAYS_AVAILABLE_TOOLS) {
    if (!out.includes(tool)) out.push(tool);
  }
  return out;
}

/**
 * Resolve one definition's tool grant against one parent (design §6.4 step 2).
 *
 * Order is load-bearing: `disallowedTools` is applied to the PARENT's sets
 * FIRST, so a denied entry can never be re-admitted by the definition's own
 * `tools` list (or by an `mcp__*` wildcard in it).
 *
 * Throws `Agent would be spawned with zero tools: <unresolved entries>` when
 * the result would grant nothing at all — no built-in, no MCP tool, and no
 * ability to spawn.
 */
export function resolveChildTools(
  type: ChildToolRequest,
  parent: ParentToolContext,
): ResolvedChildTools {
  const disallowed = type.disallowedTools ?? [];
  const deniedBuiltins = new Set(disallowed.filter((d) => !d.startsWith(MCP_PREFIX)));
  const mcpDenies = disallowed.filter((d) => d.startsWith(MCP_PREFIX));

  const allowedBuiltins = parent.builtinTools.filter((t) => !deniedBuiltins.has(t));
  const allowedMcp = parent.mcpTools.filter((m) => !mcpDenies.some((d) => mcpPatternMatches(d, m)));

  // A child sits one level below its parent; at the ceiling it gets no `agent`
  // (design §5.2: a child at depth d < maxDepth may spawn).
  const depthAllowsSpawn = parent.depth + 1 < parent.maxDepth && !deniedBuiltins.has('agent');

  // No `tools:` key — inherit the parent's whole (post-disallow) capability.
  if (type.tools === undefined) {
    if (allowedBuiltins.length === 0 && allowedMcp.length === 0 && !depthAllowsSpawn) {
      throw zeroToolsError(disallowed);
    }
    return {
      tools: allowedBuiltins,
      mcpTools: allowedMcp,
      spawnableTypes: undefined,
      canSpawn: depthAllowsSpawn,
    };
  }

  const tools: string[] = [];
  const mcpTools: string[] = [];
  const unresolved: string[] = [];
  let spawnableTypes: string[] | undefined;
  let requestsSpawn = false;

  for (const raw of type.tools) {
    const entry = raw.trim();
    if (!entry) continue;

    const agentEntry = AGENT_ENTRY_RE.exec(entry);
    if (agentEntry) {
      requestsSpawn = true;
      const inner = agentEntry[1]?.trim();
      if (inner) {
        const names = inner
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean);
        if (!spawnableTypes) spawnableTypes = [];
        for (const name of names) {
          if (!spawnableTypes.includes(name)) spawnableTypes.push(name);
        }
      }
      continue;
    }

    if (entry.startsWith(MCP_PREFIX)) {
      const matched = allowedMcp.filter((m) => mcpPatternMatches(entry, m));
      if (matched.length === 0) {
        unresolved.push(entry);
        continue;
      }
      for (const m of matched) if (!mcpTools.includes(m)) mcpTools.push(m);
      continue;
    }

    if (!allowedBuiltins.includes(entry)) {
      unresolved.push(entry);
      continue;
    }
    if (!tools.includes(entry)) tools.push(entry);
  }

  const canSpawn = requestsSpawn && depthAllowsSpawn;
  if (tools.length === 0 && mcpTools.length === 0 && !canSpawn) {
    throw zeroToolsError(unresolved);
  }
  return { tools, mcpTools, spawnableTypes, canSpawn };
}

/**
 * Resolve the child's model (design §6.4 step 3): per-call `model` →
 * definition `model` → the parent's model, with `inherit` at either level
 * meaning "fall through to the parent".
 *
 * A per-call `inherit` is an EXPLICIT instruction and beats a type-level pin —
 * the operator asked for the parent's model on this call.
 *
 * A value containing `/` is a `provider/model` id and is taken verbatim.
 * Anything else is an alias resolved through `subagents.modelAliases`; an
 * unconfigured alias falls back to the parent's model and reports a warning
 * rather than failing the spawn (Platform Adaptation 4).
 */
export function resolveChildModel(input: ResolveChildModelInput): {
  model: string;
  warning?: string;
} {
  const { requested, definition, parentModel, aliases } = input;
  if (requested === 'inherit') return { model: parentModel };
  const picked = requested ?? (definition === 'inherit' ? undefined : definition);
  if (!picked) return { model: parentModel };
  if (picked.includes('/')) return { model: picked };
  const resolved = aliases[picked];
  if (resolved) return { model: resolved };
  return {
    model: parentModel,
    warning: `alias "${picked}" is not configured (subagents.modelAliases); using the parent model`,
  };
}

/**
 * Render a definition's `skills:` list into the block appended to the child's
 * system prompt (design §6.4 step 4). `skills` is the parent backend's
 * `listSkills()` — the SAME lookup `load_skill` performs, so a name that works
 * in a prompt works here. An unknown name throws rather than silently
 * spawning a child without the knowledge its definition depends on.
 */
export function preloadSkills(
  names: string[] | undefined,
  skills: Array<{ name: string; content: string }>,
): string {
  if (!names || names.length === 0) return '';
  const byName = new Map(skills.map((s) => [s.name, s.content] as const));
  let out = '';
  for (const name of names) {
    const content = byName.get(name);
    if (content === undefined) {
      throw new Error(`Unknown skill "${name}" in definition skills list`);
    }
    out += `\n\n# Preloaded skill: ${name}\n${content}`;
  }
  return out;
}

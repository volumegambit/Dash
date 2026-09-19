import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type AgentDefinition, parseAgentDefinition } from '@dash/agent';
import {
  ROSTER_TOKEN_BUDGET,
  type ResolvedSubagentType,
  type SubagentTypeResolver,
  buildRosterText,
  builtinSubagentTypes,
  createStaticResolver,
  estimateTokens,
} from '@dash/swarm';
import type { GatewayAgentConfig } from './agent-registry.js';
import { filterAgentDefFilesByAgent } from './plugin-filtering.js';
import { subagentTypesFor } from './subagent-config.js';

/**
 * The sub-agent DEFINITION REGISTRY (spec §6.2): resolves a `subagent_type`
 * name to the definition that wins across four sources, per Dash agent.
 *
 * Precedence, LOWEST first (later layers overwrite earlier ones by name):
 *
 *   1. built-ins                       `general-purpose`, `Explore`, `Plan`
 *   2. plugin `agents/*.md`            `<plugin>:<name>` (always namespaced)
 *   3. `<dataDir>/subagents/<agentName>/*.md`   source `agent`
 *   4. `<workspace>/.claude/agents/*.md`        source `workspace`
 *   5. `<workspace>/.dash/agents/*.md`          source `workspace` (wins)
 *
 * A PLUGIN DEFINITION CAN NEVER SHADOW A BARE NAME: `parseAgentDefinition`
 * prefixes it with `<plugin>:`, and the `name` grammar forbids `:`, so the two
 * key spaces cannot collide. Bare names at a higher layer DO shadow lower ones,
 * which is how a workspace file replaces a built-in.
 *
 * Everything is resolved per AGENT and cached until `invalidate`, because every
 * input is per-agent: the workspace path, the per-agent dir (keyed on
 * `config.name`), the plugin selection, and `subagents.allowedTypes`.
 */

/** One roster entry. `shadowedBy` is set only on definitions that LOST. */
export interface ListedSubagentType extends ResolvedSubagentType {
  /**
   * Present iff this definition was shadowed by a higher-precedence one of the
   * same name — the value is the winner's `location` (its file), or its
   * `source` when it has no file (a built-in). Absent on the winner itself.
   */
  shadowedBy?: string;
}

export interface SubagentTypeListing {
  /**
   * Every definition this agent can see, narrowed by `subagents.allowedTypes`:
   * the winner for each name (in precedence-of-first-definition order) followed
   * immediately by the definitions it shadowed, highest-precedence loser first.
   */
  types: ListedSubagentType[];
  /**
   * RULING 1: `subagents.allowedTypes` entries that match NO resolvable type.
   * A case typo (`explore` for `Explore`) otherwise yields an orchestrator that
   * can spawn nothing, silently — the registry is the only layer that knows
   * every resolvable name, so it is the only layer that can catch this. Also
   * logged as a warning. NEVER fatal: the remaining valid entries still work.
   */
  unknownAllowedTypes: string[];
}

export interface SubagentDefinitionRegistryOptions {
  /** Host data dir; the per-agent dir is `<dataDir>/subagents/<agentName>/`. */
  dataDir: string;
  /**
   * LIVE read of `PluginWiringState.agentDefFiles` (plugin `agents/*.md` with
   * their plugin namespace). A getter, not a snapshot, so a plugin hot-reload
   * followed by `invalidate()` re-reads the new set.
   */
  getPluginAgentDefFiles: () => Array<{ file: string; namespace: string }>;
  /** LIVE read of an agent's config: workspace, name, plugins, allowedTypes. */
  getAgentConfig: (agentId: string) => GatewayAgentConfig | undefined;
  logger?: { warn(msg: string): void };
}

export interface SubagentDefinitionRegistry {
  /** The resolver handed to `createAgentTools`, narrowed by `allowedTypes`. */
  resolverFor(agentId: string): Promise<SubagentTypeResolver>;
  /** The same set as a list, plus shadowing + `allowedTypes` diagnostics. */
  listFor(agentId: string): Promise<SubagentTypeListing>;
  /**
   * Drop the cache for one agent (or all) and notify `onChange` listeners.
   * CALLERS OWN THE TRIGGERS (Task B8): a plugin hot-reload, a write to the
   * per-agent dir, and a `PUT /agents/:id` that changes `workspace`, `plugins`
   * or the `subagents` block all have to call this — the build snapshots each
   * of those inputs.
   */
  invalidate(agentId?: string): void;
  perAgentDir(agentName: string): string;
  onChange(listener: (agentId: string | undefined) => void): () => void;
}

/**
 * Map a parsed definition onto a spawnable type. `oneShot`/`skipMemory` are
 * hard-coded `false`: those two flags exist for the read-only built-ins
 * (`Explore`/`Plan`), and a user-authored definition is resumable via
 * `send_message` and gets the memory preamble like any other agent.
 */
export function definitionToType(d: AgentDefinition): ResolvedSubagentType {
  return {
    name: d.name,
    description: d.description,
    systemPrompt: d.systemPrompt,
    ...(d.tools && { tools: d.tools }),
    ...(d.disallowedTools && { disallowedTools: d.disallowedTools }),
    ...(d.model && { model: d.model }),
    ...(d.skills && { skills: d.skills }),
    ...(d.maxTurns !== undefined && { maxTurns: d.maxTurns }),
    ...(d.background !== undefined && { background: d.background }),
    ...(d.isolation && { isolation: d.isolation }),
    skipMemory: false,
    oneShot: false,
    source: d.source,
    location: d.location,
  };
}

/** What one cached build produces. Warnings were already emitted building it. */
interface BuiltRoster {
  types: ResolvedSubagentType[];
  listing: ListedSubagentType[];
  unknownAllowedTypes: string[];
}

/**
 * Read + parse every `*.md` in `dir`, in filename order (so a duplicate `name`
 * inside one directory resolves deterministically: last file wins).
 *
 * RULING 4: a MALFORMED FILE NEVER BREAKS RESOLUTION. Each parse failure is
 * warned with the file and the reason, and the scan continues. A missing
 * directory is not an error at all (most agents have no per-agent dir and most
 * workspaces have no `.dash/agents`), so ENOENT is silent.
 */
async function readDefinitionsFrom(
  dir: string,
  source: AgentDefinition['source'],
  warn: (msg: string) => void,
): Promise<AgentDefinition[]> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    // An absent (or not-a-directory) definition dir is the NORMAL case and is
    // silent. Anything else — a permissions problem, say — would otherwise
    // erase the agent's whole roster with no trace, so it is warned.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      warn(`[subagents] skipping ${dir}: ${(err as Error).message}`);
    }
    return [];
  }
  const out: AgentDefinition[] = [];
  for (const name of names) {
    const definition = await readDefinitionFile(join(dir, name), source, warn);
    if (definition) out.push(definition);
  }
  return out;
}

/** Read + parse ONE definition file, warning (and returning undefined) on any failure. */
async function readDefinitionFile(
  file: string,
  source: AgentDefinition['source'],
  warn: (msg: string) => void,
  namespace?: string,
): Promise<AgentDefinition | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    warn(`[subagents] skipping ${file}: ${(err as Error).message}`);
    return undefined;
  }
  const parsed = parseAgentDefinition(raw, {
    source,
    location: file,
    ...(namespace && { namespace }),
  });
  if (!parsed.ok) {
    warn(`[subagents] skipping ${file}: ${parsed.error}`);
    return undefined;
  }
  return parsed.definition;
}

/**
 * Neutralise anything in an agent name that could escape
 * `<dataDir>/subagents/`. Agent names are operator-supplied and NOT validated
 * by `agent-registry.ts`, and Task B8 writes definition files through
 * `perAgentDir`, so an unsanitised name would be an arbitrary-write primitive
 * (`name: '../../etc'`). Only traversal is neutralised — separators, `..` and
 * NUL become `_`, a name that is nothing but dots becomes `_` — so ordinary
 * names (including ones with spaces) still map to a readable directory.
 *
 * SANITISATION IS LOSSY, AND B8 MADE THIS A WRITE PATH. `a/b` and `a_b` both
 * flatten to `a_b`, so two distinct agents would share one directory and each
 * would see (and be able to DELETE) the other's definitions. When — and only
 * when — flattening actually changed the name, a short digest of the ORIGINAL
 * is appended, which makes the mapping injective again. Re-keying on the
 * registry id would also fix it but would fight spec §6.2's `<agentName>`
 * layout and make every existing directory unreachable; the ordinary name (the
 * overwhelming majority) is left byte-identical and readable.
 */
function safeAgentDirName(agentName: string): string {
  const flattened = agentName.replace(/[/\\\0]/g, '_').replace(/\.\./g, '_');
  const safe = flattened.trim() === '' || /^\.+$/.test(flattened) ? '_' : flattened;
  if (safe === agentName) return safe;
  return `${safe}-${createHash('sha256').update(agentName).digest('hex').slice(0, 8)}`;
}

/**
 * Canonicalise a FILE definition's name onto a built-in's exact spelling when
 * the two match case-insensitively (spec §6.3: "built-ins can be shadowed by a
 * user definition of the same name").
 *
 * The `name` grammar is lowercase-only, so `Explore` is unspellable in a file.
 * Without this, `explore.md` would not override the built-in at all — it would
 * ADD a second, near-identical `explore` next to `Explore` in the roster, and
 * the operator's override would silently never apply to the name they meant.
 * Canonicalising here (rather than relaxing the grammar or matching
 * case-insensitively at resolve time) keeps the set of valid `subagent_type`
 * strings exactly as it was and leaves the roster advertising `Explore` only.
 */
function canonicaliseBuiltinName(
  type: ResolvedSubagentType,
  canonicalByLower: Map<string, string>,
): ResolvedSubagentType {
  const canonical = canonicalByLower.get(type.name.toLowerCase());
  return canonical && canonical !== type.name ? { ...type, name: canonical } : type;
}

export function createSubagentDefinitionRegistry(
  o: SubagentDefinitionRegistryOptions,
): SubagentDefinitionRegistry {
  const warn = (msg: string) => o.logger?.warn(msg);
  // Cached PROMISES, not values: two concurrent `resolverFor`/`listFor` calls
  // for the same agent share one scan, so the warnings fire exactly once.
  const cache = new Map<string, Promise<BuiltRoster>>();
  const listeners = new Set<(agentId: string | undefined) => void>();

  const perAgentDir = (agentName: string) =>
    join(o.dataDir, 'subagents', safeAgentDirName(agentName));

  async function build(agentId: string): Promise<BuiltRoster> {
    const config = o.getAgentConfig(agentId);
    if (!config) {
      warn(`[subagents] unknown agent id "${agentId}"; using the built-in types only`);
      const types = builtinSubagentTypes();
      return { types, listing: [...types], unknownAllowedTypes: [] };
    }

    // --- Gather every layer, LOWEST PRECEDENCE FIRST. ---
    const builtins = builtinSubagentTypes();
    const layers: ResolvedSubagentType[] = [...builtins];
    // `explore.md` must SHADOW the built-in `Explore`, not sit beside it.
    const canonicalByLower = new Map(builtins.map((b) => [b.name.toLowerCase(), b.name]));
    const toType = (d: AgentDefinition) =>
      canonicaliseBuiltinName(definitionToType(d), canonicalByLower);

    // Plugins, narrowed by the agent's plugin selection (`undefined` = all).
    // Their names are already `<plugin>:<name>`, so they occupy a key space no
    // bare definition can reach.
    for (const { file, namespace } of filterAgentDefFilesByAgent(
      config.plugins,
      o.getPluginAgentDefFiles(),
    )) {
      const definition = await readDefinitionFile(file, 'plugin', warn, namespace);
      if (definition) layers.push(toType(definition));
    }

    // Per-Dash-agent dir, then the workspace dirs (`.claude` before `.dash`, so
    // `.dash` overwrites it).
    const dirs: Array<{ dir: string; source: AgentDefinition['source'] }> = [
      { dir: perAgentDir(config.name), source: 'agent' },
    ];
    if (config.workspace) {
      dirs.push({ dir: join(config.workspace, '.claude', 'agents'), source: 'workspace' });
      dirs.push({ dir: join(config.workspace, '.dash', 'agents'), source: 'workspace' });
    }
    for (const { dir, source } of dirs) {
      for (const definition of await readDefinitionsFrom(dir, source, warn)) {
        layers.push(toType(definition));
      }
    }

    // --- Merge by name: later (higher-precedence) entries overwrite earlier
    // ones. `Map.set` on an existing key KEEPS the original insertion position,
    // so the roster order stays stable (built-ins first) while the value is the
    // winner. Losers are kept for the listing's `shadowedBy`. ---
    const winners = new Map<string, ResolvedSubagentType>();
    const shadowed = new Map<string, ResolvedSubagentType[]>();
    for (const type of layers) {
      const previous = winners.get(type.name);
      if (previous) shadowed.set(type.name, [previous, ...(shadowed.get(type.name) ?? [])]);
      winners.set(type.name, type);
    }

    // --- `allowedTypes` narrowing + RULING 1 validation. ---
    const all = [...winners.values()];
    const types = subagentTypesFor(config, all);
    const unknownAllowedTypes = (config.subagents?.allowedTypes ?? []).filter(
      (name) => !winners.has(name),
    );
    if (unknownAllowedTypes.length > 0) {
      warn(
        `[subagents] agent "${config.name}": subagents.allowedTypes names ` +
          `${unknownAllowedTypes.length} unknown sub-agent type(s): ` +
          `${unknownAllowedTypes.join(', ')} (ignored; the remaining entries still apply)`,
      );
    }

    // --- RULING 3: roster token budget (spec §5.4). Warn ONCE naming the
    // biggest offenders; never truncate, never throw — a silently shortened
    // roster is worse than an over-long one the operator can see and fix. ---
    warnIfOverBudget(config.name, types, warn);

    // The listing follows the resolver: a name `allowedTypes` hid is absent
    // from both, shadowed entries included.
    const visible = new Set(types.map((t) => t.name));
    const listing: ListedSubagentType[] = [];
    for (const [name, winner] of winners) {
      if (!visible.has(name)) continue;
      listing.push(winner);
      const shadowedBy = winner.location ?? winner.source;
      for (const loser of shadowed.get(name) ?? []) {
        listing.push({ ...loser, shadowedBy });
      }
    }

    return { types, listing, unknownAllowedTypes };
  }

  function get(agentId: string): Promise<BuiltRoster> {
    const cached = cache.get(agentId);
    if (cached) return cached;
    const built = build(agentId);
    cache.set(agentId, built);
    // A FAILED build must not be cached forever: drop it so the next call
    // retries. Callers still see this rejection; this handler only evicts.
    built.catch(() => {
      if (cache.get(agentId) === built) cache.delete(agentId);
    });
    return built;
  }

  return {
    async resolverFor(agentId) {
      return createStaticResolver((await get(agentId)).types);
    },
    async listFor(agentId) {
      const { listing, unknownAllowedTypes } = await get(agentId);
      return { types: listing, unknownAllowedTypes };
    },
    invalidate(agentId) {
      if (agentId === undefined) cache.clear();
      else cache.delete(agentId);
      for (const listener of listeners) listener(agentId);
    },
    perAgentDir,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Spec §5.4: the combined type DESCRIPTIONS (what actually ships in the
 * `subagent_type` parameter description every turn) are capped at
 * `ROSTER_TOKEN_BUDGET`. Over it, log one warning that names the offending
 * definitions largest first so the operator knows which file to trim.
 */
function warnIfOverBudget(
  agentName: string,
  types: ResolvedSubagentType[],
  warn: (msg: string) => void,
): void {
  // Measure the STRING THAT SHIPS, not the descriptions alone: `buildRosterText`
  // adds `- <name>: ` and ` (Tools: <list>)` per entry, so many small
  // definitions can blow the budget while a description-only sum stays quiet.
  // The tool column is approximated with the definition's declared tools (`*`
  // when it inherits) — the exact grant depends on the parent's live tool set,
  // which the registry does not know; descriptions dominate the total either way.
  const total = estimateTokens(buildRosterText(types, (t) => (t.tools ?? ['*']).join(', ')));
  if (total <= ROSTER_TOKEN_BUDGET) return;
  const sizes = types.map((t) => ({ name: t.name, tokens: estimateTokens(t.description) }));
  const worst = sizes
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)
    .map((s) => `${s.name} (~${s.tokens})`)
    .join(', ');
  warn(
    `[subagents] agent "${agentName}": the sub-agent roster sent to the model is ` +
      `~${total} tokens, over the ${ROSTER_TOKEN_BUDGET} budget; nothing was truncated, so ` +
      `the full roster is still sent. Shorten these descriptions, largest first: ${worst}`,
  );
}

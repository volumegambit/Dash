/**
 * Per-agent plugin visibility filtering (Plan P5, Task 1).
 *
 * Pure function: given an agent's plugin selection plus the gateway-wide plugin
 * wiring contributions, return the subset of skill dirs, command files and
 * sub-agent definition files that agent may see. NO I/O, NO mutation of inputs.
 *
 * TRUST IS NOT THIS FUNCTION'S CONCERN. Per-agent `plugins` selection is
 * VISIBILITY / ROUTING ONLY — it decides which already-loaded plugins an agent
 * can use. Whether a plugin is enabled or trusted (and thus whether its
 * code-execution contributions — MCP / hooks / bin / providers — were activated
 * vs left as `noop`) is decided gateway-wide upstream, in `loadPlugins` +
 * `rebuildWiringState`. An untrusted plugin's code stays `noop` regardless of
 * any agent selecting it here. This filter only narrows the already-derived,
 * already-trust-gated skill dirs, command files and agent definitions.
 */

/**
 * Narrow plugin SUB-AGENT DEFINITION files (`agents/*.md`) to the plugins an
 * agent has selected. Same semantics as the `agentDefFiles` channel of
 * {@link filterPluginsByAgent} — `undefined` selection = all, `[]` = none —
 * exposed on its own because the definition registry needs ONLY this channel
 * and passing empty arrays for the other four parameters would be both noise
 * and a transposition hazard (skill dirs, command files and agent definitions
 * are structurally identical). `filterPluginsByAgent` delegates here, so the
 * two paths can never drift.
 */
export function filterAgentDefFilesByAgent(
  agentPlugins: string[] | undefined,
  allAgentDefFiles: Array<{ file: string; namespace: string }>,
): Array<{ file: string; namespace: string }> {
  if (agentPlugins === undefined) return allAgentDefFiles;
  const selected = new Set(agentPlugins);
  return allAgentDefFiles.filter((af) => selected.has(af.namespace));
}

/**
 * Filter the gateway's plugin skill dirs, command files and sub-agent
 * definition files down to the plugins an agent has selected.
 *
 * @param agentPlugins   The agent's `GatewayAgentConfig.plugins`. `undefined`
 *   means "all loaded plugins" (backward compat for legacy agents). An explicit
 *   `[]` means "none" — the empty literal is honored verbatim. (The MC layer is
 *   responsible for mapping an empty selection back to `undefined`; this pure
 *   function does NOT, so callers get exactly what they asked for.)
 * @param allSkillDirs   The flat aggregate of all loaded plugins' skill dirs
 *   (`wiringState.skillDirs`). Drives the OUTPUT ORDER of the filtered dirs.
 * @param allCommandFiles  All loaded plugins' `commands/*.md` files, each tagged
 *   with its contributing plugin in `namespace` (`wiringState.commandFiles`).
 *   These become flat `load_skill`-able skills named `<plugin>:<command>`.
 * @param skillDirsByPlugin  Per-plugin attribution map (plugin name → that
 *   plugin's skill dirs), from `wiringState.skillDirsByPlugin`. Used only for
 *   membership testing — a dir belongs to the result iff some selected plugin
 *   contributed it.
 * @param allAgentDefFiles  All loaded plugins' `agents/*.md` SUB-AGENT
 *   DEFINITION files (`wiringState.agentDefFiles`), same `{ file, namespace }`
 *   shape. Narrowed with the same semantics as `allCommandFiles` (`undefined`
 *   selection = all, `[]` = none). These are definitions, NOT loadable skills —
 *   see spec §6.2 — so they are returned in their own array and are never
 *   folded into `commandFiles`.
 * @returns `{ skillDirs, commandFiles, agentDefFiles }` narrowed to the
 *   selection. A selected plugin name that isn't loaded contributes nothing
 *   (no throw).
 */
export function filterPluginsByAgent<Command extends { file: string; namespace?: string }>(
  agentPlugins: string[] | undefined,
  allSkillDirs: string[],
  allCommandFiles: Command[],
  skillDirsByPlugin: Record<string, string[]>,
  allAgentDefFiles: Array<{ file: string; namespace: string }>,
): {
  skillDirs: string[];
  commandFiles: Command[];
  agentDefFiles: Array<{ file: string; namespace: string }>;
} {
  // Backward compat: no per-agent selection → the agent sees everything.
  // Return the inputs as-is (callers treat the result as read-only).
  if (agentPlugins === undefined) {
    return {
      skillDirs: allSkillDirs,
      commandFiles: allCommandFiles,
      agentDefFiles: allAgentDefFiles,
    };
  }

  // Build the set of skill dirs contributed by the SELECTED plugins. Unknown
  // (not-loaded) plugin names simply have no entry in `skillDirsByPlugin`, so
  // they contribute nothing — no throw. Membership is by exact dir path.
  const selectedDirs = new Set<string>();
  for (const name of agentPlugins) {
    for (const dir of skillDirsByPlugin[name] ?? []) {
      selectedDirs.add(dir);
    }
  }

  // Preserve the flat aggregate's ORDER and dedup by iterating `allSkillDirs`
  // and keeping only those a selected plugin contributed. (Intersecting with
  // `allSkillDirs` also drops anything the attribution map names that the flat
  // aggregate filtered out upstream.) `allSkillDirs` is already deduped, so a
  // single pass preserves first-occurrence order.
  const skillDirs = allSkillDirs.filter((dir) => selectedDirs.has(dir));

  // Command files and agent definitions both carry their plugin in `namespace`
  // — filter each directly, keeping the two channels separate.
  const selectedNames = new Set(agentPlugins);
  // A command file with no namespace belongs to no plugin, so no selection can
  // include it — same result the un-narrowed `has(undefined)` produced.
  const commandFiles = allCommandFiles.filter(
    (cf) => cf.namespace !== undefined && selectedNames.has(cf.namespace),
  );
  const agentDefFiles = filterAgentDefFilesByAgent(agentPlugins, allAgentDefFiles);

  return { skillDirs, commandFiles, agentDefFiles };
}

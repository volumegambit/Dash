/**
 * Per-agent plugin visibility filtering (Plan P5, Task 1).
 *
 * Pure function: given an agent's plugin selection plus the gateway-wide plugin
 * wiring contributions, return the subset of skill dirs + command files that
 * agent may see. NO I/O, NO mutation of inputs.
 *
 * TRUST IS NOT THIS FUNCTION'S CONCERN. Per-agent `plugins` selection is
 * VISIBILITY / ROUTING ONLY — it decides which already-loaded plugins an agent
 * can use. Whether a plugin is enabled or trusted (and thus whether its
 * code-execution contributions — MCP / hooks / bin / providers — were activated
 * vs left as `noop`) is decided gateway-wide upstream, in `loadPlugins` +
 * `rebuildWiringState`. An untrusted plugin's code stays `noop` regardless of
 * any agent selecting it here. This filter only narrows the already-derived,
 * already-trust-gated skill dirs + command files.
 */

/**
 * Filter the gateway's plugin skill dirs + command files down to the plugins an
 * agent has selected.
 *
 * @param agentPlugins   The agent's `GatewayAgentConfig.plugins`. `undefined`
 *   means "all loaded plugins" (backward compat for legacy agents). An explicit
 *   `[]` means "none" — the empty literal is honored verbatim. (The MC layer is
 *   responsible for mapping an empty selection back to `undefined`; this pure
 *   function does NOT, so callers get exactly what they asked for.)
 * @param allSkillDirs   The flat aggregate of all loaded plugins' skill dirs
 *   (`wiringState.skillDirs`). Drives the OUTPUT ORDER of the filtered dirs.
 * @param allCommandFiles  All loaded plugins' command/agent files, each tagged
 *   with its contributing plugin in `namespace` (`wiringState.commandFiles`).
 * @param skillDirsByPlugin  Per-plugin attribution map (plugin name → that
 *   plugin's skill dirs), from `wiringState.skillDirsByPlugin`. Used only for
 *   membership testing — a dir belongs to the result iff some selected plugin
 *   contributed it.
 * @returns `{ skillDirs, commandFiles }` narrowed to the selection. A selected
 *   plugin name that isn't loaded contributes nothing (no throw).
 */
export function filterPluginsByAgent(
  agentPlugins: string[] | undefined,
  allSkillDirs: string[],
  allCommandFiles: Array<{ file: string; namespace: string }>,
  skillDirsByPlugin: Record<string, string[]>,
): { skillDirs: string[]; commandFiles: Array<{ file: string; namespace: string }> } {
  // Backward compat: no per-agent selection → the agent sees everything.
  // Return the inputs as-is (callers treat the result as read-only).
  if (agentPlugins === undefined) {
    return { skillDirs: allSkillDirs, commandFiles: allCommandFiles };
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

  // Command files carry their plugin in `namespace` — filter directly.
  const selectedNames = new Set(agentPlugins);
  const commandFiles = allCommandFiles.filter((cf) => selectedNames.has(cf.namespace));

  return { skillDirs, commandFiles };
}

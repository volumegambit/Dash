import type { AgentRegistry, GatewayAgentConfig } from './agent-registry.js';

/**
 * One-time migration for the removed `skills.includeBundled` flag.
 *
 * Agents that opted OUT of the bundled library (`includeBundled: false`) and
 * have no explicit per-agent `plugins` list get one: every currently-loaded
 * NON-builtin plugin. That preserves the opt-out (builtins excluded, user
 * plugins still visible) at the documented cost that the list is now explicit
 * — future installs no longer auto-flow to these agents. Agents with an
 * explicit list, or with `includeBundled: true`, just lose the flag.
 *
 * Idempotent: agents without the key are untouched, and the key is stripped
 * on migration, so a second run is a no-op. Returns the number migrated.
 */
export async function migrateIncludeBundled(
  registry: AgentRegistry,
  wiringRecords: Record<string, { builtin?: boolean }>,
  logger: { info(msg: string): void; warn(msg: string): void },
): Promise<number> {
  const nonBuiltin = Object.entries(wiringRecords)
    .filter(([, r]) => r.builtin !== true)
    .map(([name]) => name)
    .sort();

  let migrated = 0;
  for (const agent of registry.list()) {
    // The field was removed from GatewayAgentConfig; persisted agents.json
    // entries may still carry it, so read it through a legacy cast.
    const skills = agent.config.skills as
      | (NonNullable<GatewayAgentConfig['skills']> & { includeBundled?: boolean })
      | undefined;
    if (skills?.includeBundled === undefined) continue;

    const optedOut = skills.includeBundled === false;
    const { includeBundled: _stripped, ...cleanSkills } = skills;
    const patch: Partial<Omit<GatewayAgentConfig, 'name' | 'plugins'>> & {
      plugins?: string[] | null;
    } = { skills: cleanSkills };
    if (optedOut && agent.config.plugins === undefined) {
      patch.plugins = nonBuiltin;
    }
    registry.update(agent.id, patch);
    migrated++;
    logger.info(
      `[migrate] agent '${agent.name}': removed skills.includeBundled${
        optedOut && patch.plugins ? `; plugins set to [${patch.plugins.join(', ')}]` : ''
      }`,
    );
  }
  if (migrated > 0) await registry.save();
  return migrated;
}

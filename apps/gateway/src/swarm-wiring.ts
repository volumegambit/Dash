/**
 * DEPRECATED path. This module was renamed to `subagent-wiring.ts` when the
 * worker factory stopped building a stripped SWARM worker and started building
 * a definition-driven SUB-AGENT (design §6.4 step 6).
 *
 * Kept as a re-export shim for one release so an in-flight branch importing the
 * old path keeps compiling. Import from `./subagent-wiring.js` in new code.
 */
export * from './subagent-wiring.js';

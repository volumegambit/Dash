import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DashAgent,
  type DashAgentConfig,
  type ExtraTool,
  type Logger,
  PiAgentBackend,
  type ProviderApiKeysSource,
} from '@dash/agent';
import type { WorkerBackend, WorkerFactory, WorkerSpec } from '@dash/swarm';

/**
 * Dependencies for the gateway's swarm worker factory. Mirrors the subset of
 * the chat-path `createBackend` inputs a STRIPPED worker actually needs: a
 * pull-based credential source and the data dir root (for the worker's private
 * session dir). Everything else a normal agent backend gets — MCP, projects
 * tools, managed skills, command files, hooks, the plugin model catalog — is
 * deliberately absent for workers.
 */
export interface GatewayWorkerFactoryDeps {
  /** Same pull-based credential source the chat-path backend factory uses. */
  credentialProvider: ProviderApiKeysSource;
  /** Gateway data dir root; worker session dirs live under it. */
  dataDir: string;
  /** Optional gateway logger, forwarded to the backend. */
  logger?: Logger;
}

/**
 * Rules for a LEGACY `spawn_worker` worker (a spec with no `subagentType`).
 * Wording is frozen: these strings are concatenated back into exactly the
 * preamble workers have always received.
 */
const LEGACY_WORKER_RULES = [
  '- Complete the task below and put your full findings in your FINAL message — it is your ' +
    'report to the orchestrator.',
  '- If you are blocked and need a decision, call the ask_orchestrator tool once and continue ' +
    'with its answer.',
  '- You share the workspace with other workers. Only touch files your task requires.',
];

/** Rules for a definition-driven child spawned through the `agent` tool. */
const CHILD_AGENT_RULES = [
  '- Put your complete findings in your FINAL message — it is your report; the parent sees ' +
    'nothing else.',
  '- If you are blocked on a decision only the parent can make, call ask_orchestrator once and ' +
    'continue with its answer.',
  '- You share the workspace with the parent and sibling agents. Only touch files your task ' +
    'requires.',
  '- Never claim to be the user or the parent.',
];

/**
 * `a` / `an` for a subagent type name, chosen by its leading letter so the
 * identity line reads correctly for both built-in and user-defined types:
 * "an Explore agent", "a Plan agent", "a general-purpose agent".
 */
function articleFor(typeName: string): string {
  return /^[aeiou]/i.test(typeName) ? 'an' : 'a';
}

/**
 * The child's system-prompt preamble: identity + rules, then the definition
 * body (`spec.systemPrompt`, when the spec came from a subagent definition),
 * then the parent-issued brief under a `# Task` heading.
 *
 * Two shapes, decided by `spec.subagentType`:
 * - ABSENT — a legacy `spawn_worker` spec. Returns the original swarm-worker
 *   preamble byte-for-byte (orchestrator wording, three rules, no body).
 * - PRESENT — a definition-driven child of the `agent` tool. Identity carries
 *   the addressable name, the type, the worker id and the depth; the rules
 *   name the parent rather than an orchestrator; the definition body is
 *   inserted verbatim between the rules and the task.
 */
export function buildWorkerPreamble(spec: WorkerSpec): string {
  const task = `# Task\n${spec.brief}`;

  if (!spec.subagentType) {
    const identity = [
      `You are "${spec.role}" (worker ${spec.workerId}), an ephemeral worker agent in a swarm`,
      'run by an orchestrator.',
    ].join(' ');
    return `${identity}\nRules:\n${LEGACY_WORKER_RULES.join('\n')}\n\n${task}`;
  }

  const who = spec.name ?? spec.subagentType;
  const identity = [
    `You are "${who}", ${articleFor(spec.subagentType)} ${spec.subagentType} agent`,
    `(id ${spec.workerId}, depth ${spec.depth ?? 1}) working on one task`,
    'delegated by a parent agent.',
  ].join(' ');
  const body = spec.systemPrompt?.trim();
  const sections = [`${identity}\nRules:\n${CHILD_AGENT_RULES.join('\n')}`];
  if (body) sections.push(body);
  sections.push(task);
  return sections.join('\n\n');
}

/**
 * The `DashAgentConfig` a spawned child runs under — the single source of
 * truth for both the backend's construction-time config and the `DashAgent`
 * config resolver the factory installs, so the two can never disagree.
 *
 * `memory.enabled` is `false` for children the definition marks `skipMemory`
 * (Explore / Plan): they are turn-scoped researchers whose findings belong in
 * their report, not in the workspace MEMORY.md. Every other child keeps the
 * normal memory behaviour.
 */
export function buildWorkerAgentConfig(spec: WorkerSpec): DashAgentConfig {
  return {
    model: spec.model,
    systemPrompt: buildWorkerPreamble(spec),
    tools: spec.tools,
    memory: { enabled: !spec.skipMemory },
  };
}

/**
 * Absolute session dir for a single worker:
 * `<dataDir>/sessions/<agentName>/.swarm/<runId>/<workerId>`. The `.swarm`
 * segment keeps worker sessions out of the agent's normal conversation
 * listing while still living under the agent's session tree.
 */
export function workerSessionDir(dataDir: string, spec: WorkerSpec): string {
  return resolve(dataDir, 'sessions', spec.agentName, '.swarm', spec.runId, spec.workerId);
}

/**
 * The positional constructor arguments for a worker's `PiAgentBackend`, as a
 * tuple. THIS is the stripped-path contract, factored out so it can be
 * unit-tested without booting pi: every MCP slot (mcpManager, mcpConfigStore,
 * mcpAgentContext), managedSkillsDir, extraSkillFiles/commandFiles, hookRunner,
 * and pluginModelCatalog is `undefined`. A worker gets ONLY:
 * credentialProvider + sessionDir + the coordinator-built `spec.extraTools`
 * (the `ask_orchestrator` tool).
 *
 * The arg order matches `PiAgentBackend`'s constructor exactly:
 * (config, providerApiKeysSource, logger, sessionDir, managedSkillsDir,
 *  mcpManager, mcpConfigStore, mcpAgentContext, extraTools, extraSkillFiles,
 *  hookRunner, pluginModelCatalog).
 */
export function buildWorkerBackendArgs(
  spec: WorkerSpec,
  deps: GatewayWorkerFactoryDeps,
): ConstructorParameters<typeof PiAgentBackend> {
  return [
    buildWorkerAgentConfig(spec),
    deps.credentialProvider,
    deps.logger, // logger
    workerSessionDir(deps.dataDir, spec), // sessionDir
    undefined, // managedSkillsDir — NONE
    undefined, // mcpManager — NONE
    undefined, // mcpConfigStore — NONE
    undefined, // mcpAgentContext — NONE
    // Worker-side extra tools (ask_orchestrator), built by the coordinator.
    // SwarmExtraTool is a structural copy of ExtraTool; cast keeps @dash/swarm
    // free of an @dash/agent value dependency.
    spec.extraTools as unknown as ExtraTool[],
    undefined, // extraSkillFiles / command files — NONE
    undefined, // hookRunner — NONE (Subagent hooks fire from WorkerHandle)
    undefined, // pluginModelCatalog — worker models are the orchestrator's anyway
  ];
}

/**
 * Build the gateway's swarm `WorkerFactory`. Each call spawns a STRIPPED
 * `PiAgentBackend` (see `buildWorkerBackendArgs`), starts it on the worker's
 * shared workspace, and wraps it in a `DashAgent` whose config resolver returns
 * the worker's fixed model / preamble / tools. The returned `WorkerBackend`
 * adapts `DashAgent.chat` to the single-message worker turn contract and
 * delegates abort/stop straight to the backend.
 */
export function createGatewayWorkerFactory(deps: GatewayWorkerFactoryDeps): WorkerFactory {
  return async (spec: WorkerSpec): Promise<WorkerBackend> => {
    const sessionDir = workerSessionDir(deps.dataDir, spec);
    await mkdir(sessionDir, { recursive: true });

    const backend = new PiAgentBackend(...buildWorkerBackendArgs(spec, deps));
    await backend.start(spec.workspace);

    // Static resolver: a worker's model / preamble / tools / memory policy are
    // fixed for the life of the spawn, so resolve once and hand back the same
    // config on every turn.
    const config = buildWorkerAgentConfig(spec);
    const agent = new DashAgent(backend, async () => config);

    return {
      chat: (message: string) => agent.chat('swarm', `${spec.runId}-${spec.workerId}`, message),
      abort: () => backend.abort(),
      stop: () => backend.stop(),
    };
  };
}

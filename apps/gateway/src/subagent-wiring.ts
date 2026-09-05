import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DashAgent,
  type DashAgentConfig,
  type ExtraTool,
  type FlatSkillFile,
  type HookRunner,
  type Logger,
  PiAgentBackend,
  type PiAgentBackendOptions,
  type PluginModelCatalog,
  type ProviderApiKeysSource,
} from '@dash/agent';
import type { McpManager } from '@dash/mcp';
import type { WorkerBackend, WorkerFactory, WorkerSpec } from '@dash/swarm';

/**
 * The credential + session-dir floor every spawned child needs, whatever its
 * definition granted: a pull-based credential source and the data dir root
 * (children get a private session dir under it).
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
 * The full DEFINITION-DRIVEN child contract (design §6.4 step 6). What a child
 * holds is decided by the grant the coordinator resolved for it, not by a
 * blanket strip:
 *
 * - MCP — the parent's shared `mcpManager`, handed over ONLY when the resolved
 *   grant names MCP tools, and then narrowed twice: `assignedMcpServers` to the
 *   servers those tools live on and `mcpToolAllowlist` to the exact
 *   `server__tool` names. The MCP MANAGEMENT slots (`mcpConfigStore`,
 *   `mcpAgentContext`) are never passed, so `mcp_add_server` and friends stay
 *   structurally unreachable for a child.
 * - Skills — the parent's skill DIRS (read) and its filtered command files, so
 *   the `load_skill` every grant carries actually resolves. The parent's
 *   `managedSkillsDir` (WRITE) is never passed, so `create_skill` /
 *   `install_skill` / `remove_skill` stay unreachable.
 * - Hooks — the parent's `hookRunner`, so PreToolUse/PostToolUse plugin policy
 *   applies to the child's tool calls too. A child holding `bash` or MCP that
 *   bypassed the operator's hooks would be a policy hole.
 *
 * The skill getters take the SPEC, not nothing: skill dirs are per-PARENT
 * (`<dataDir>/skills/<agentName>` plus that agent's plugin selection), so a
 * single gateway-wide list would let a child of agent A load agent B's skills.
 */
export interface ChildBackendDeps extends GatewayWorkerFactoryDeps {
  /** The gateway's shared MCP manager; only reaches children granted MCP tools. */
  mcpManager?: McpManager;
  /** Plugin-contributed model catalog, so a child can resolve the same model ids. */
  pluginModelCatalog?: PluginModelCatalog;
  /** The parent's plugin hook runner. */
  hookRunner?: HookRunner;
  /** READ-ONLY skill roots for this spec's parent agent. */
  getParentSkillDirs: (spec: WorkerSpec) => string[];
  /** The parent's filtered flat skill/command files. */
  getExtraSkillFiles: (spec: WorkerSpec) => FlatSkillFile[];
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
 * The MCP servers a grant of `server__tool` names touches, in first-seen order.
 * Feeds `DashAgentConfig.assignedMcpServers`, the COARSE gate; the exact names
 * are re-applied afterwards by `mcpToolAllowlist`.
 */
function mcpServersFor(mcpTools: string[]): string[] {
  const servers: string[] = [];
  for (const tool of mcpTools) {
    const server = tool.split('__')[0];
    if (server && !servers.includes(server)) servers.push(server);
  }
  return servers;
}

/**
 * The `DashAgentConfig` a spawned child runs under — the single source of
 * truth for both the backend's construction-time config and the `DashAgent`
 * config resolver the factory installs, so the two can never disagree.
 *
 * `workspace` is set from the spec. It is not cosmetic: `DashAgent.chat` gates
 * the MEMORY.md preamble on `config.workspace && config.memory?.enabled !==
 * false`, so without it the `memory` flag below would be inert and NO child —
 * general-purpose included — would ever see the project's memory.
 *
 * `memory.enabled` is `false` for children the definition marks `skipMemory`
 * (Explore / Plan): they are turn-scoped researchers whose findings belong in
 * their report, not in the workspace MEMORY.md. Every other child keeps the
 * normal memory behaviour.
 */
export function buildChildAgentConfig(spec: WorkerSpec, deps: ChildBackendDeps): DashAgentConfig {
  const mcpTools = spec.mcpTools ?? [];
  const skillPaths = deps.getParentSkillDirs(spec);
  return {
    model: spec.model,
    systemPrompt: buildWorkerPreamble(spec),
    // `mcp` is not an inheritable capability of its own — it is the gate name
    // `PiAgentBackend.buildCustomTools` reads before registering ANY MCP tool.
    // Add it only when the resolved grant actually contains MCP tools, so a
    // child with none cannot reach the MCP registry at all.
    tools: mcpTools.length > 0 ? [...spec.tools, 'mcp'] : spec.tools,
    memory: { enabled: !spec.skipMemory },
    workspace: spec.workspace,
    // Read-only skill discovery: enough for `load_skill` (which every grant
    // carries) to resolve, without the managedSkillsDir that would also arm
    // create_skill / install_skill / remove_skill.
    skills: { paths: skillPaths },
    ...(mcpTools.length > 0
      ? { assignedMcpServers: mcpServersFor(mcpTools), mcpToolAllowlist: mcpTools }
      : {}),
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
 * Every `PiAgentBackend` construction input for one spawned child, as a NAMED
 * options object. THIS is the child contract, factored out so it can be
 * unit-tested without booting pi.
 *
 * What a child gets, and — just as load-bearing — what it does not:
 *
 * | slot                | child | why                                        |
 * |---------------------|-------|--------------------------------------------|
 * | mcpManager          | grant | only when the grant names MCP tools        |
 * | assignedMcpServers  | grant | the servers those tools live on            |
 * | mcpToolAllowlist    | grant | the exact `server__tool` names             |
 * | mcpConfigStore      | never | would arm mcp_add_server / mcp_remove      |
 * | mcpAgentContext     | never | same                                       |
 * | skills.paths        | yes   | read-only; makes `load_skill` resolve      |
 * | extraSkillFiles     | yes   | the parent's filtered command files        |
 * | managedSkillsDir    | never | would arm create/install/remove_skill      |
 * | hookRunner          | yes   | plugin tool policy must cover children     |
 * | pluginModelCatalog  | yes   | the child resolves the same model ids      |
 *
 * The MCP grant is an INTERSECTION at every step — the coordinator already
 * bounded `spec.mcpTools` by the orchestrator's own MCP tools
 * (`validateMcpTools`), and `mcpToolAllowlist` is applied by the backend AFTER
 * the server filter — so a child naming a server it was not granted gets
 * nothing rather than the server's other tools.
 */
export function buildChildBackendOptions(
  spec: WorkerSpec,
  deps: ChildBackendDeps,
): PiAgentBackendOptions {
  const hasMcp = (spec.mcpTools?.length ?? 0) > 0;
  return {
    config: buildChildAgentConfig(spec, deps),
    providerApiKeysSource: deps.credentialProvider,
    logger: deps.logger,
    sessionDir: workerSessionDir(deps.dataDir, spec),
    // managedSkillsDir — NEVER: read-only over skills (see the table above).
    mcpManager: hasMcp ? deps.mcpManager : undefined,
    // mcpConfigStore / mcpAgentContext — NEVER: no MCP management for a child.
    // Child-side extra tools (ask_orchestrator), built by the coordinator.
    // SwarmExtraTool is a structural copy of ExtraTool; the cast keeps
    // @dash/swarm free of an @dash/agent value dependency.
    extraTools: spec.extraTools as unknown as ExtraTool[],
    extraSkillFiles: deps.getExtraSkillFiles(spec),
    hookRunner: deps.hookRunner,
    pluginModelCatalog: deps.pluginModelCatalog,
  };
}

/**
 * Build the gateway's swarm `WorkerFactory`. Each call spawns a child
 * `PiAgentBackend` from `buildChildBackendOptions`, starts it on the child's
 * shared workspace, and wraps it in a `DashAgent` whose config resolver returns
 * the child's fixed model / preamble / tools. The returned `WorkerBackend`
 * adapts `DashAgent.chat` to the single-message worker turn contract and
 * delegates abort/stop straight to the backend.
 */
export function createGatewayWorkerFactory(deps: ChildBackendDeps): WorkerFactory {
  return async (spec: WorkerSpec): Promise<WorkerBackend> => {
    const options = buildChildBackendOptions(spec, deps);
    await mkdir(workerSessionDir(deps.dataDir, spec), { recursive: true });

    const backend = PiAgentBackend.fromOptions(options);
    await backend.start(spec.workspace);

    // Static resolver: a child's model / preamble / tools / memory policy are
    // fixed for the life of the spawn, so hand back the SAME config object the
    // backend was constructed with on every turn — the two cannot disagree.
    const agent = new DashAgent(backend, async () => options.config);

    return {
      chat: (message: string) => agent.chat('swarm', `${spec.runId}-${spec.workerId}`, message),
      abort: () => backend.abort(),
      stop: () => backend.stop(),
    };
  };
}

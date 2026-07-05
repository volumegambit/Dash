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
 * The exact worker system-prompt preamble. Identity + swarm rules, then the
 * orchestrator-issued brief under a `# Task` heading. Kept verbatim so the
 * worker reliably (a) reports back in its FINAL message, (b) uses
 * `ask_orchestrator` for blocking decisions, and (c) respects the shared
 * workspace.
 */
export function buildWorkerPreamble(spec: WorkerSpec): string {
  return `You are "${spec.role}" (worker ${spec.workerId}), an ephemeral worker agent in a swarm run by an orchestrator.
Rules:
- Complete the task below and put your full findings in your FINAL message — it is your report to the orchestrator.
- If you are blocked and need a decision, call the ask_orchestrator tool once and continue with its answer.
- You share the workspace with other workers. Only touch files your task requires.

# Task
${spec.brief}`;
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
  const config: DashAgentConfig = {
    model: spec.model,
    systemPrompt: buildWorkerPreamble(spec),
    tools: spec.tools,
  };
  return [
    config,
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

    const preamble = buildWorkerPreamble(spec);
    const agent = new DashAgent(backend, async () => ({
      model: spec.model,
      systemPrompt: preamble,
      tools: spec.tools,
    }));

    return {
      chat: (message: string) => agent.chat('swarm', `${spec.runId}-${spec.workerId}`, message),
      abort: () => backend.abort(),
      stop: () => backend.stop(),
    };
  };
}

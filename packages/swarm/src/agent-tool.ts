import type { SwarmCoordinator } from './coordinator.js';
import { scanSubagentOutput } from './output-scan.js';
import {
  type ParentToolContext,
  parentBuiltinTools,
  preloadSkills,
  resolveChildModel,
  resolveChildTools,
} from './resolve-spawn.js';
import { type SubagentTypeResolver, buildRosterText } from './subagent-types.js';
import type { SwarmExtraTool } from './types.js';

/**
 * The orchestrator-facing sub-agent tools: `agent` (launch a typed child and
 * either block on its report or leave it running) and `send_message` (continue
 * a named child with its context intact).
 *
 * Error discipline matches the other swarm tools: expected failures THROW an
 * Error with actionable text and pi converts the throw into an isError result.
 */

export const AGENT_TOOL_DESCRIPTION =
  'Launch a new agent to handle a self-contained task. Each agent type has ' +
  'its own tools and system prompt. Reach for this when a task matches an ' +
  "agent type's description, when independent work can run in parallel " +
  '(call agent several times in one turn), or when answering would mean ' +
  'reading across many files - delegate the search and keep the conclusion, ' +
  'not the file dumps. Once you have delegated a search, do not also run it ' +
  "yourself. The agent's final report is returned to you and is NOT shown " +
  'to the user - relay what matters. Use send_message with the ' +
  "agent's name or id to continue a previous agent with its context " +
  'intact; a new agent call starts fresh. Set run_in_background: true for ' +
  'long independent work; you will be notified when it completes. ' +
  'isolation: "worktree" gives the agent its own git worktree of the ' +
  'workspace.';

const SEND_MESSAGE_DESCRIPTION =
  'Send a message to one of your agents by name or id. A running agent ' +
  'receives it after its current step; a finished agent resumes with its ' +
  "context intact. Returns immediately; the agent's next completion is " +
  'delivered to you as a notification (or via wait_workers in this gateway ' +
  'version).';

const TURN_SCOPED_NOTE =
  ' Note: in this gateway version a background agent is scoped to this turn ' +
  '— collect it with wait_workers before you finish, or it is cancelled ' +
  'when your turn ends.';

const DETACHED_NOTE = ' You will be notified when it completes.';

const NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$';
const NAME_RE = new RegExp(NAME_PATTERN);

export interface CreateAgentToolsOptions {
  coordinator: SwarmCoordinator;
  agentId: string;
  /** Late-bound conversation id: resolved per tool invocation. */
  conversationId: () => string;
  resolver: SubagentTypeResolver;
  /**
   * Phase A: 'turn-scoped' (background children are cancelled at turn end).
   * Phase C: 'detached'.
   */
  backgroundMode: 'turn-scoped' | 'detached';
  /**
   * The parent's effective context at spawn time. NEW: provides builtins,
   * MCPs, depth, maxDepth all together so the roster and grant match.
   */
  parentContext?: () => ParentToolContext;
  /**
   * LEGACY (Phase A): effective tools of the parent for roster rendering.
   * Superseded by `parentContext`; ignored if both are present.
   */
  parentTools?: () => string[];
  /**
   * The parent's model ID for inheritance and fallback.
   */
  parentModel?: () => string;
  /**
   * Model aliases for per-call resolution: `{ haiku: 'anthropic/claude-haiku' }`.
   */
  modelAliases?: () => Record<string, string>;
  /**
   * Skill lookup for preloading: async function that lists available skills.
   */
  listSkills?: () => Promise<Array<{ name: string; content: string }>>;
  /** Parent's depth; children get depth+1 (default 0 - 1). */
  depth?: number;
}

/** Coerce a raw params value into a shape with known optional fields. */
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

export function createAgentTools(opts: CreateAgentToolsOptions): SwarmExtraTool[] {
  const { coordinator, agentId, resolver } = opts;
  const convo = () => opts.conversationId();

  // Resolve parent context: prefer parentContext, fall back to parentTools
  const getParentContext = (): ParentToolContext => {
    if (opts.parentContext) {
      return opts.parentContext();
    }
    // Fallback for Phase A: construct context from parentTools (legacy path).
    // Do NOT add ALWAYS_AVAILABLE_TOOLS here - if the parent's config doesn't
    // include them, they shouldn't be inherited. The test setup that wants them
    // will use parentContext with parentBuiltinTools() explicitly.
    const configTools = opts.parentTools?.() ?? [];
    return {
      builtinTools: configTools,
      mcpTools: [],
      depth: opts.depth ?? 0,
      maxDepth: 3,
    };
  };

  // Child depth is calculated from parent context, computed at spawn time
  const getChildDepth = () => getParentContext().depth + 1;

  /**
   * Compute the resolved tools and MCPs for a given definition (design section 6.4
   * step 2). The roster and the spawn both use this result, so they cannot drift.
   */
  const resolveTools = (typeTools: string[] | undefined, typeMcps?: string[]) => {
    const parent = getParentContext();
    const resolved = resolveChildTools({ tools: typeTools }, parent);
    return {
      tools: resolved.tools,
      mcpTools: resolved.mcpTools,
      spawnableTypes: resolved.spawnableTypes,
      canSpawn: resolved.canSpawn,
    };
  };

  const rosterDescription = () => {
    const parent = getParentContext();
    const roster = buildRosterText(resolver.list(), (t) => {
      try {
        const resolved = resolveTools(t.tools);
        const all = [...resolved.tools, ...resolved.mcpTools];
        return all.length > 0 ? all.join(', ') : 'none — no overlap with your tools';
      } catch {
        // Definition would grant zero tools - advertise that fact.
        return 'none — no overlap with your tools';
      }
    });
    return `${roster}\nDefaults to general-purpose.`;
  };

  /**
   * Rebuilt on every read (the `parameters` getter below). PiAgentBackend's
   * `buildCustomTools` copies `parameters` by value at wrap time, so a lazy
   * getter is what lets `refreshCustomTools()` pick up a changed roster.
   */
  const buildParameters = () =>
    ({
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'The task for the agent to perform. Self-contained: it does not ' +
            'see this conversation.',
        },
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the task, shown in the UI.',
        },
        subagent_type: { type: 'string', description: rosterDescription() },
        model: {
          type: 'string',
          description:
            'Optional model override: a provider/model id, an alias (fable, ' +
            'opus, sonnet, haiku), or inherit.',
        },
        name: {
          type: 'string',
          pattern: NAME_PATTERN,
          description:
            'Optional name; makes the agent addressable via send_message ' +
            'while running and after it finishes.',
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Run concurrently and notify this conversation on completion. ' +
            'Default false. Use for long independent work.',
        },
        isolation: {
          type: 'string',
          enum: ['worktree'],
          description: 'Give the agent its own git worktree of the workspace.',
        },
      },
      required: ['prompt', 'description'],
      additionalProperties: false,
    }) as const;

  const agent: SwarmExtraTool = {
    name: 'agent',
    label: 'Agent',
    description: AGENT_TOOL_DESCRIPTION,
    get parameters() {
      return buildParameters();
    },
    execute: async (_id, params, signal) => {
      const p = asRecord(params);
      const prompt = typeof p.prompt === 'string' ? p.prompt : '';
      const description = typeof p.description === 'string' ? p.description : '';
      if (!prompt) throw new Error('prompt is required.');
      if (!description) throw new Error('description is required.');
      const typeName =
        typeof p.subagent_type === 'string' && p.subagent_type
          ? p.subagent_type
          : 'general-purpose';
      const type = resolver.resolve(typeName);
      if (!type) {
        const valid = resolver
          .list()
          .map((t) => t.name)
          .join(', ');
        throw new Error(`Unknown subagent_type "${typeName}". Valid types: ${valid}`);
      }
      const name = typeof p.name === 'string' ? p.name : undefined;
      if (name !== undefined && !NAME_RE.test(name)) {
        throw new Error('name must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$');
      }

      const background = p.run_in_background === true || type.background === true;
      const isolation =
        p.isolation === 'worktree' || type.isolation === 'worktree' ? 'worktree' : undefined;

      // Resolve tools (design section 6.4 step 2)
      const parent = getParentContext();
      const resolved = resolveChildTools({ tools: type.tools }, parent);

      // Resolve model (design section 6.4 step 3)
      const requestedModel = typeof p.model === 'string' ? p.model : undefined;
      const parentModelStr = opts.parentModel?.() ?? 'parent-model';
      const modelResult = resolveChildModel({
        requested: requestedModel,
        definition: type.model,
        parentModel: parentModelStr,
        aliases: opts.modelAliases?.() ?? {},
      });
      // Only pin a model if it was explicitly requested or defined, AND it
      // resolves to a non-parent value. Per-call 'inherit' overrides definition
      // model. If an alias is unconfigured, we pass undefined.
      const hasExplicitRequest = requestedModel !== undefined;
      const hasDefinitionModel = type.model && type.model !== 'inherit';
      let pinModel: string | undefined;
      if (hasExplicitRequest) {
        // Explicit per-call model (or 'inherit') overrides definition
        pinModel = requestedModel === 'inherit' ? undefined : modelResult.model;
        if (modelResult.warning) pinModel = undefined;
      } else if (hasDefinitionModel) {
        // Definition model, but only if it resolves cleanly
        pinModel = modelResult.warning ? undefined : modelResult.model;
      } else {
        // No explicit request, no definition - let coordinator decide
        pinModel = undefined;
      }

      // Preload skills (design section 6.4 step 4)
      let systemPrompt = type.systemPrompt;
      let skillError: Error | undefined;
      if (type.skills && type.skills.length > 0) {
        try {
          const skills = await opts.listSkills?.();
          if (skills) {
            const skillsBlock = preloadSkills(type.skills, skills);
            systemPrompt = type.systemPrompt + skillsBlock;
          }
        } catch (e) {
          skillError = e instanceof Error ? e : new Error(String(e));
        }
      }

      if (skillError) throw skillError;

      const { workerId } = coordinator.spawnWorker(agentId, convo(), {
        role: name ?? type.name,
        brief: prompt,
        tools: resolved.tools,
        mcpTools: resolved.mcpTools.length > 0 ? resolved.mcpTools : undefined,
        canSpawn: resolved.canSpawn,
        spawnableTypes: resolved.spawnableTypes,
        model: pinModel,
        subagentType: type.name,
        description,
        name,
        systemPrompt,
        background,
        isolation,
        skipMemory: type.skipMemory,
        maxTurns: type.maxTurns,
        oneShot: type.oneShot,
        depth: getChildDepth(),
      });

      const statusText = modelResult.warning ? `\n\nNote: ${modelResult.warning}` : '';

      if (background) {
        const note = opts.backgroundMode === 'turn-scoped' ? TURN_SCOPED_NOTE : DETACHED_NOTE;
        return {
          content: [
            {
              type: 'text',
              text: `Agent ${name ?? workerId} launched in the background.${note}${statusText}`,
            },
          ],
          details: {
            subagentId: workerId,
            name,
            status: 'running',
            ...(modelResult.warning && { warning: modelResult.warning }),
          },
        };
      }

      const snap = await coordinator.waitWorker(agentId, convo(), workerId, signal);
      const scanned = scanSubagentOutput(snap.report ?? '');
      const header =
        snap.status === 'done' ? '' : `[agent finished with status: ${snap.status}]\n\n`;
      const now = Date.now();
      return {
        content: [
          {
            type: 'text',
            text: header + scanned.text + statusText,
          },
        ],
        details: {
          subagentId: workerId,
          name,
          subagentType: type.name,
          status: snap.status,
          usage: snap.usage,
          toolCallCount: snap.toolCallCount,
          elapsedMs: (snap.endedAt ?? now) - (snap.startedAt ?? now),
          scannerMatched: scanned.matched,
          ...(modelResult.warning && { warning: modelResult.warning }),
        },
      };
    },
  };

  const sendMessage: SwarmExtraTool = {
    name: 'send_message',
    label: 'Send Message',
    description: SEND_MESSAGE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'The name or id of one of your agents in this conversation.',
        },
        message: { type: 'string', description: 'The message to deliver to that agent.' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const p = asRecord(params);
      const to = typeof p.to === 'string' ? p.to : '';
      const message = typeof p.message === 'string' ? p.message : '';
      if (!to) throw new Error('to is required.');
      if (!message) throw new Error('message is required.');
      const target = coordinator.findWorker(agentId, convo(), to);
      if (!target) throw new Error(`No agent named or with id "${to}" in this conversation.`);
      if (target.oneShot) {
        const kind = target.subagentType;
        throw new Error(
          `Agent "${to}" is a one-shot ${kind} agent and cannot be resumed. Launch a new one.`,
        );
      }
      const { ok, status } = coordinator.sendToWorker(agentId, convo(), {
        workerId: target.workerId,
        message,
      });
      if (!ok) throw new Error(`could not deliver to ${to} (${status})`);
      return {
        content: [{ type: 'text', text: `delivered to ${target.name ?? target.workerId}` }],
        details: { subagentId: target.workerId, status },
      };
    },
  };

  return [agent, sendMessage];
}

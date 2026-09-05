import type { SwarmCoordinator } from './coordinator.js';
import { scanSubagentOutput } from './output-scan.js';
import {
  type ChildToolRequest,
  type ParentToolContext,
  type ResolvedChildTools,
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
  'reading across many files — delegate the search and keep the conclusion, ' +
  'not the file dumps. Once you have delegated a search, do not also run it ' +
  "yourself. The agent's final report is returned to you and is NOT shown " +
  'to the user — relay what matters. Use send_message with the ' +
  "agent's name or id to continue a previous agent with its context " +
  'intact; a new agent call starts fresh. Set run_in_background: true for ' +
  'long independent work; you will be notified when it completes. ' +
  'isolation: "worktree" gives the agent its own git worktree of the ' +
  'workspace.';

const SEND_MESSAGE_DESCRIPTION =
  'Send a message to one of your agents by name or id. A running agent ' +
  'receives it after its current step; a finished agent resumes with its ' +
  'context intact. Returns immediately; the agent’s next completion is ' +
  'delivered to you as a notification (or via wait_workers in this gateway ' +
  'version).';

const TURN_SCOPED_NOTE =
  ' Note: in this gateway version a background agent is scoped to this turn ' +
  '— collect it with wait_workers before you finish, or it is cancelled ' +
  'when your turn ends.';

const DETACHED_NOTE = ' You will be notified when it completes.';

const NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$';
const NAME_RE = new RegExp(NAME_PATTERN);

/** What the roster says for a definition that resolves to nothing shareable. */
const NO_OVERLAP = 'none — no overlap with your tools';

/** Nesting ceiling assumed when the caller supplies no `parentContext`. */
const DEFAULT_MAX_DEPTH = 3;

/**
 * Stands in for the parent's model when the caller wired none. It is only ever
 * COMPARED against (a result equal to it means "inherit, pin nothing"), so it
 * cannot reach the coordinator and be rejected as an unknown model.
 */
const UNKNOWN_PARENT_MODEL = '\u0000unknown-parent-model';

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
  /** Parent's depth; children get depth+1 (default 0 → 1). */
  depth?: number;
}

/** Coerce a raw params value into a shape with known optional fields. */
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

export function createAgentTools(opts: CreateAgentToolsOptions): SwarmExtraTool[] {
  const { coordinator, agentId, resolver } = opts;
  const convo = () => opts.conversationId();

  /**
   * The parent's effective capabilities at this moment. `parentContext` is the
   * real thing; `parentTools` is the legacy Phase A shape and is put through
   * `parentBuiltinTools` on the way in — a parent's RAW `config.tools` can name
   * tools no child may ever inherit (`create_skill`, `mcp_add_server`, …), and
   * passing those straight through would advertise them in the roster and then
   * fail the spawn in the coordinator's `validateTools`.
   */
  const getParentContext = (): ParentToolContext =>
    opts.parentContext?.() ?? {
      builtinTools: parentBuiltinTools(opts.parentTools?.()),
      mcpTools: [],
      depth: opts.depth ?? 0,
      maxDepth: DEFAULT_MAX_DEPTH,
    };

  /**
   * The ONE resolution (design §6.4 step 2) behind both the roster and the
   * spawn, `disallowedTools` included — resolving them separately is how a
   * definition's denial ends up honoured in one and dropped from the other.
   * The parent context is returned with the grant so the caller reads the depth
   * the grant was computed against rather than re-reading it.
   */
  const resolveGrant = (
    type: ChildToolRequest,
  ): { parent: ParentToolContext; grant: ResolvedChildTools } => {
    const parent = getParentContext();
    return { parent, grant: resolveChildTools(type, parent) };
  };

  const rosterDescription = () => {
    const roster = buildRosterText(resolver.list(), (t) => {
      try {
        const { grant } = resolveGrant(t);
        const all = [...grant.tools, ...grant.mcpTools];
        return all.length > 0 ? all.join(', ') : NO_OVERLAP;
      } catch {
        // The definition would grant zero tools — advertise that fact rather
        // than throwing while rendering the schema.
        return NO_OVERLAP;
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

      // Tools (design §6.4 step 2) — the same computation the roster reads.
      const { parent, grant } = resolveGrant(type);

      // Model (design §6.4 step 3). `resolveChildModel` already encodes the
      // whole precedence (per-call → definition → parent, `inherit` at either
      // level falling through, an unconfigured alias warning and falling back),
      // so the only thing left to decide is whether to PIN the result: a model
      // equal to the parent's is inheritance, and passing `undefined` lets the
      // coordinator apply its own authoritative read of the orchestrator model.
      const parentModel = opts.parentModel?.() ?? UNKNOWN_PARENT_MODEL;
      const modelResult = resolveChildModel({
        requested: typeof p.model === 'string' ? p.model : undefined,
        definition: type.model,
        parentModel,
        aliases: opts.modelAliases?.() ?? {},
      });
      const pinModel = modelResult.model === parentModel ? undefined : modelResult.model;

      // Skills (design §6.4 step 4). An unknown name throws (in preloadSkills)
      // and so does a definition that names skills with no lookup wired: both
      // would otherwise spawn a child missing the knowledge it depends on.
      let systemPrompt = type.systemPrompt;
      if (type.skills && type.skills.length > 0) {
        if (!opts.listSkills) {
          const named = type.skills.join(', ');
          throw new Error(
            `subagent type "${type.name}" preloads skills (${named}) but no skill lookup is wired`,
          );
        }
        systemPrompt += preloadSkills(type.skills, await opts.listSkills());
      }

      const { workerId } = coordinator.spawnWorker(agentId, convo(), {
        role: name ?? type.name,
        brief: prompt,
        tools: grant.tools,
        mcpTools: grant.mcpTools.length > 0 ? grant.mcpTools : undefined,
        canSpawn: grant.canSpawn,
        spawnableTypes: grant.spawnableTypes,
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
        depth: parent.depth + 1,
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

      // FOREGROUND: the child is part of THIS turn, so an abort of the tool
      // call (a cancelled turn, a closed socket) takes the child down with it.
      // A background child is deliberately not touched here — it is detached.
      let snap: Awaited<ReturnType<SwarmCoordinator['waitWorker']>>;
      try {
        snap = await coordinator.waitWorker(agentId, convo(), workerId, signal);
      } catch (err) {
        void coordinator.cancelChild(workerId, 'the parent turn was cancelled').catch(() => {});
        throw err;
      }
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
          // Where the child worked. For an `isolation: worktree` child this is
          // its own checkout — the only pointer a user gets to work it left
          // behind uncommitted (design 5.2).
          ...(snap.workspace !== undefined ? { workspace: snap.workspace } : {}),
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
      // One gate for both outcomes: a RUNNING child queues the message as its
      // next turn, a FINISHED one is resumed with it now. Both return at once —
      // the child's next completion comes back as a notification.
      const { status, mode } = coordinator.sendToChild(convo(), to, message);
      const who = target.name ?? target.workerId;
      return {
        content: [
          { type: 'text', text: mode === 'resumed' ? `resumed ${who}` : `delivered to ${who}` },
        ],
        details: { subagentId: target.workerId, status, mode },
      };
    },
  };

  return [agent, sendMessage];
}

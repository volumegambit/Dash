import type { SwarmCoordinator } from './coordinator.js';
import { scanSubagentOutput } from './output-scan.js';
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

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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
  /** Effective tools of the parent for roster rendering. */
  parentTools: () => string[];
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
  const childDepth = (opts.depth ?? 0) + 1;

  const rosterDescription = () => {
    const roster = buildRosterText(resolver.list(), (t) =>
      t.tools ? t.tools.join(', ') : opts.parentTools().join(', '),
    );
    return `${roster}\nDefaults to general-purpose.`;
  };

  const parameters = {
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
  } as const;

  const agent: SwarmExtraTool = {
    name: 'agent',
    label: 'Agent',
    description: AGENT_TOOL_DESCRIPTION,
    parameters,
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
      const model =
        typeof p.model === 'string' && p.model !== 'inherit'
          ? p.model
          : type.model && type.model !== 'inherit'
            ? type.model
            : undefined;

      const { workerId } = coordinator.spawnWorker(agentId, convo(), {
        role: name ?? type.name,
        brief: prompt,
        tools: type.tools,
        model,
        subagentType: type.name,
        description,
        name,
        systemPrompt: type.systemPrompt,
        background,
        isolation,
        skipMemory: type.skipMemory,
        maxTurns: type.maxTurns,
        oneShot: type.oneShot,
        depth: childDepth,
      });

      if (background) {
        const note = opts.backgroundMode === 'turn-scoped' ? TURN_SCOPED_NOTE : DETACHED_NOTE;
        return {
          content: [
            { type: 'text', text: `Agent ${name ?? workerId} launched in the background.${note}` },
          ],
          details: { subagentId: workerId, name, status: 'running' },
        };
      }

      const snap = await coordinator.waitWorker(agentId, convo(), workerId, signal);
      const scanned = scanSubagentOutput(snap.report ?? '');
      const header =
        snap.status === 'done' ? '' : `[agent finished with status: ${snap.status}]\n\n`;
      const now = Date.now();
      return {
        content: [{ type: 'text', text: header + scanned.text }],
        details: {
          subagentId: workerId,
          name,
          subagentType: type.name,
          status: snap.status,
          usage: snap.usage,
          toolCallCount: snap.toolCallCount,
          elapsedMs: (snap.endedAt ?? now) - (snap.startedAt ?? now),
          scannerMatched: scanned.matched,
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

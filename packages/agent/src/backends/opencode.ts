import { createServer } from 'node:net';
import { createOpencodeClient, createOpencodeServer } from '@opencode-ai/sdk/v2';
import { buildToolsMap, parseModel } from '../config-generator.js';
import type { Logger } from '../logger.js';
import { SessionIdMap } from '../session-id-map.js';
import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  DashAgentConfig,
  RunOptions,
} from '../types.js';

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

type OcClient = ReturnType<typeof createOpencodeClient>;

/** Extracts the skill name from a completed skill tool event. Returns null for all other events. */
export function extractSkillName(event: { type: string; properties: unknown }): string | null {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic event shape
  const part = (event.properties as any)?.part;
  if (part?.type !== 'tool' || part.tool !== 'skill') return null;
  if (part.state?.status !== 'completed') return null;
  return part.state?.input?.name ?? null;
}

export class OpenCodeBackend implements AgentBackend {
  readonly name = 'opencode';

  private sdk: OcClient | null = null;
  private serverClose: (() => void) | null = null;
  private sessionIdMap = new SessionIdMap();
  private currentSessionId: string | null = null;

  constructor(
    private config: DashAgentConfig,
    private providerApiKeys: Record<string, string>,
    private logger?: Logger,
  ) {}

  async start(workspace: string): Promise<void> {
    const port = await findFreePort();
    const server = await createOpencodeServer({
      port,
      config: {
        model: this.config.model,
        ...(this.config.skills && { skills: this.config.skills }),
      },
    });
    this.serverClose = () => server.close();

    this.sdk = createOpencodeClient({
      baseUrl: server.url,
      directory: workspace,
    });

    // Register provider API keys
    for (const [providerID, key] of Object.entries(this.providerApiKeys)) {
      if (key) {
        await this.sdk.auth.set({ providerID, auth: { type: 'api', key } });
      }
    }

    // Rebuild session map from existing sessions
    // biome-ignore lint/suspicious/noExplicitAny: SDK type is richer than SessionClient interface
    await this.sessionIdMap.init(this.sdk as any);
  }

  async *run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent> {
    if (!this.sdk) throw new Error('OpenCodeBackend not started. Call start() first.');

    const sessionId = await this.sessionIdMap.getOrCreate(
      state.channelId,
      state.conversationId,
      // biome-ignore lint/suspicious/noExplicitAny: SDK type is richer than SessionClient interface
      this.sdk as any,
    );
    this.currentSessionId = sessionId;

    const { providerID, modelID } = parseModel(state.model);
    const tools = buildToolsMap(state.tools);

    // Subscribe to SSE events BEFORE sending prompt (avoid missing early events)
    const { stream: eventStream } = await this.sdk.event.subscribe();

    // Fire prompt (blocks until done; run concurrently with SSE consumption)
    const promptPromise = this.sdk.session.prompt({
      sessionID: sessionId,
      model: { providerID, modelID },
      system: state.systemPrompt,
      tools,
      parts: [{ type: 'text', text: state.message }],
    });

    try {
      // Consume SSE events until this session goes idle
      for await (const event of eventStream) {
        if (options.signal?.aborted) break;

        // biome-ignore lint/suspicious/noExplicitAny: SDK Event is a union type; we access properties dynamically by event.type
        const eventProps = event.properties as any;

        // Check for end-of-turn
        if (
          event.type === 'session.status' &&
          eventProps.sessionID === sessionId &&
          eventProps.status?.type === 'idle'
        ) {
          break;
        }

        // Auto-approve permission requests (headless mode)
        if (event.type === 'permission.asked' && eventProps.sessionID === sessionId) {
          this.logger?.warn(
            `[OpenCode] auto-approving permission: ${eventProps.permission}`,
            { patterns: JSON.stringify(eventProps.patterns), sessionId },
          );
          // biome-ignore lint/suspicious/noExplicitAny: SDK client's permission API not in generated type
          await (this.sdk as any).permission
            .reply({ requestID: eventProps.id, reply: 'once' })
            .catch(() => {});
          continue;
        }

        const normalized = this.normalizeEvent(event, sessionId);
        if (normalized !== null) {
          yield normalized;
          if (normalized.type === 'tool_result' && normalized.name === 'skill') {
            const skillName = extractSkillName(event);
            if (skillName) {
              yield { type: 'skill_loaded', name: skillName };
            }
          }
        }
      }
    } finally {
      this.currentSessionId = null;
    }

    await promptPromise;
  }

  normalizeEvent(
    event: { type: string; properties: unknown },
    sessionId: string,
  ): AgentEvent | null {
    // biome-ignore lint/suspicious/noExplicitAny: SDK Event properties vary by event.type union
    const props = event.properties as any;

    switch (event.type) {
      case 'message.part.delta': {
        if (props.sessionID !== sessionId) return null;
        if (props.field === 'text') return { type: 'text_delta', text: props.delta };
        if (props.field === 'reasoning') return { type: 'thinking_delta', text: props.delta };
        return null;
      }

      case 'message.part.updated': {
        const part = props.part;
        if (!part || part.sessionID !== sessionId) return null;

        switch (part.type) {
          case 'tool': {
            const state = part.state;
            if (state.status === 'pending') {
              return { type: 'tool_use_start', id: part.callID, name: part.tool };
            }
            if (state.status === 'running') {
              return { type: 'tool_use_delta', partial_json: JSON.stringify(state.input) };
            }
            if (state.status === 'completed') {
              return {
                type: 'tool_result',
                id: part.callID,
                name: part.tool,
                content: state.output,
              };
            }
            if (state.status === 'error') {
              return {
                type: 'tool_result',
                id: part.callID,
                name: part.tool,
                content: state.error,
                isError: true,
              };
            }
            return null;
          }
          case 'patch':
            return { type: 'file_changed', files: part.files };
          case 'agent':
            return { type: 'agent_spawned', name: part.name };
          case 'compaction':
            return { type: 'context_compacted', overflow: part.overflow ?? false };
          case 'retry':
            return {
              type: 'agent_retry',
              attempt: part.attempt,
              reason: part.error?.message ?? 'unknown',
            };
          default:
            return null;
        }
      }

      case 'session.status': {
        if (props.sessionID !== sessionId) return null;
        if (props.status?.type === 'retry') {
          return {
            type: 'agent_retry',
            attempt: props.status.attempt,
            reason: props.status.message,
          };
        }
        return null;
      }

      case 'session.error': {
        if (props.sessionID && props.sessionID !== sessionId) return null;
        const msg = props.error?.message ?? 'Unknown OpenCode error';
        this.logger?.error(`[OpenCode] session.error: ${msg}`, {
          sessionId: props.sessionID,
          errorCode: props.error?.code,
          rawProps: JSON.stringify(props),
        });
        return { type: 'error', error: new Error(msg) };
      }

      case 'question.asked': {
        if (props.sessionID !== sessionId) return null;
        const first = props.questions?.[0];
        if (!first) return null;
        return {
          type: 'question',
          id: props.id,
          question: first.question,
          // biome-ignore lint/suspicious/noExplicitAny: SDK question option shape is untyped
          options: first.options?.map((o: any) => o.label) ?? [],
        };
      }

      default:
        return null;
    }
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    if (!this.sdk) return;
    // biome-ignore lint/suspicious/noExplicitAny: SDK client's question API not in generated type
    await (this.sdk as any).question.reply({ requestID: id, answers });
  }

  abort(): void {
    if (this.sdk && this.currentSessionId) {
      // biome-ignore lint/suspicious/noExplicitAny: SDK client's abort API accessed dynamically
      (this.sdk as any).session.abort({ sessionID: this.currentSessionId }).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.serverClose?.();
    this.serverClose = null;
    this.sdk = null;
  }

  async listSkills(): Promise<
    Array<{ name: string; description: string; location: string; content: string }>
  > {
    if (!this.sdk) return [];
    const response = await this.sdk.app.skills();
    if (response.error) throw new Error(`Failed to list skills: ${String(response.error)}`);
    return response.data ?? [];
  }
}

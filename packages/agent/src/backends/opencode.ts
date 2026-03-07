import { createOpencodeServer, createOpencodeClient } from '@opencode-ai/sdk/v2';
import { SessionIdMap } from '../session-id-map.js';
import { parseModel, buildToolsMap } from '../config-generator.js';
import type { AgentBackend, AgentEvent, AgentState, DashAgentConfig, RunOptions } from '../types.js';

type OcClient = ReturnType<typeof createOpencodeClient>;

export class OpenCodeBackend implements AgentBackend {
  readonly name = 'opencode';

  private sdk: OcClient | null = null;
  private serverClose: (() => void) | null = null;
  private sessionIdMap = new SessionIdMap();
  private currentSessionId: string | null = null;

  constructor(
    private config: DashAgentConfig,
    private providerApiKeys: Record<string, string>,
  ) {}

  async start(workspace: string): Promise<void> {
    const server = await createOpencodeServer({
      config: { model: this.config.model },
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
    await this.sessionIdMap.init(this.sdk as any);
  }

  async *run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent> {
    if (!this.sdk) throw new Error('OpenCodeBackend not started. Call start() first.');

    const sessionId = await this.sessionIdMap.getOrCreate(
      state.channelId,
      state.conversationId,
      this.sdk as any,
    );
    this.currentSessionId = sessionId;

    const { providerID, modelID } = parseModel(state.model);
    const tools = buildToolsMap(state.tools);

    // Subscribe to SSE events BEFORE sending prompt (avoid missing early events)
    const eventStream = this.sdk.event.subscribe();

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

        // Check for end-of-turn
        if (
          event.type === 'session.status' &&
          (event.properties as any).sessionID === sessionId &&
          (event.properties as any).status?.type === 'idle'
        ) {
          break;
        }

        // Auto-approve permission requests (headless mode)
        if (event.type === 'permission.asked' && (event.properties as any).sessionID === sessionId) {
          const permProps = event.properties as any;
          console.warn(`[opencode] auto-approving permission: ${permProps.permission} ${JSON.stringify(permProps.patterns)}`);
          await (this.sdk as any).permission.reply({ requestID: permProps.id, reply: 'once' }).catch(() => {});
          continue;
        }

        const normalized = this.normalizeEvent(event, sessionId);
        if (normalized !== null) {
          yield normalized;
        }
      }
    } finally {
      this.currentSessionId = null;
    }

    await promptPromise;
  }

  normalizeEvent(event: { type: string; properties: unknown }, sessionId: string): AgentEvent | null {
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
              return { type: 'tool_result', id: part.callID, name: part.tool, content: state.output };
            }
            if (state.status === 'error') {
              return { type: 'tool_result', id: part.callID, name: part.tool, content: state.error, isError: true };
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
            return { type: 'agent_retry', attempt: part.attempt, reason: part.error?.message ?? 'unknown' };
          default:
            return null;
        }
      }

      case 'session.status': {
        if (props.sessionID !== sessionId) return null;
        if (props.status?.type === 'retry') {
          return { type: 'agent_retry', attempt: props.status.attempt, reason: props.status.message };
        }
        return null;
      }

      case 'session.error': {
        if (props.sessionID && props.sessionID !== sessionId) return null;
        const msg = props.error?.message ?? 'Unknown OpenCode error';
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
          options: first.options?.map((o: any) => o.label) ?? [],
        };
      }

      default:
        return null;
    }
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    if (!this.sdk) return;
    await (this.sdk as any).question.reply({ requestID: id, answers });
  }

  abort(): void {
    if (this.sdk && this.currentSessionId) {
      (this.sdk as any).session.abort({ sessionID: this.currentSessionId }).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.serverClose?.();
    this.serverClose = null;
    this.sdk = null;
  }
}

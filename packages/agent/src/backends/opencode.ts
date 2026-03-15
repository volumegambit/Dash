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

  // Track tool call IDs that have already emitted tool_use_delta to avoid
  // duplicate full-JSON emissions (the SDK fires multiple 'running' updates)
  private emittedToolDeltas = new Set<string>();

  // Watchdog state
  private watchdogInterval: NodeJS.Timeout | null = null;
  private watchdogHealthUrl = '';
  private watchdogFailureCount = 0;
  private watchdogRestartCount = 0;
  private watchdogWindowStart = 0;
  private readonly WATCHDOG_POLL_MS = 5_000;
  private readonly WATCHDOG_FAILURE_THRESHOLD = 3;
  private readonly WATCHDOG_MAX_RESTARTS = 5;
  private readonly WATCHDOG_WINDOW_MS = 10 * 60 * 1_000;

  // Stored for restartWithBackoff
  private workDir: string | null = null;
  private watchdogRestarting = false;

  constructor(
    private config: DashAgentConfig,
    private providerApiKeys: Record<string, string>,
    private logger?: Logger,
    private opencodeStateDir?: string,
  ) {}

  /** Returns a redacted summary of provider keys for logging, e.g. "anthropic:sk-ant-***abcdefghij" */
  private static redactKeys(keys: Record<string, string>): string {
    return Object.entries(keys)
      .map(([provider, key]) => {
        if (!key) return `${provider}:(empty)`;
        const prefix = key.slice(0, 6);
        const suffix = key.slice(-10);
        const authType = OpenCodeBackend.isOAuthToken(key) ? 'oauth' : 'api';
        return `${provider}:${prefix}***${suffix} (${authType})`;
      })
      .join(', ');
  }

  /** Detect OAuth access tokens (e.g. sk-ant-oat01-...) vs regular API keys (sk-ant-api...) */
  private static isOAuthToken(key: string): boolean {
    return key.startsWith('sk-ant-oat');
  }

  /** Build the correct auth payload for the OpenCode SDK based on key type */
  private static buildAuth(
    key: string,
  ):
    | { type: 'api'; key: string }
    | { type: 'oauth'; access: string; refresh: string; expires: number } {
    if (OpenCodeBackend.isOAuthToken(key)) {
      // OAuth access token — set a far-future expiry (1 year from now)
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;
      return { type: 'oauth', access: key, refresh: '', expires: Date.now() + oneYearMs };
    }
    return { type: 'api', key };
  }

  /** Maps provider IDs to environment variable names used by the opencode binary. */
  private static readonly PROVIDER_ENV_VARS: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_API_KEY',
  };

  /**
   * Injects provider API keys and XDG isolation dirs into process.env before
   * spawning the opencode server. createOpencodeServer spreads process.env,
   * so the binary needs these values there.
   */
  private injectEnvForServer(): void {
    // Provider API keys
    for (const [providerID, key] of Object.entries(this.providerApiKeys)) {
      const envVar = OpenCodeBackend.PROVIDER_ENV_VARS[providerID];
      if (envVar && key) {
        process.env[envVar] = key;
      }
    }

    // Isolate OpenCode state via XDG directories so multiple deployments
    // don't share a single global SQLite DB and auth.json.
    if (this.opencodeStateDir) {
      const join = (a: string, b: string) => `${a}/${b}`;
      process.env.XDG_DATA_HOME = join(this.opencodeStateDir, 'data');
      process.env.XDG_CONFIG_HOME = join(this.opencodeStateDir, 'config');
      process.env.XDG_STATE_HOME = join(this.opencodeStateDir, 'state');
      process.env.XDG_CACHE_HOME = join(this.opencodeStateDir, 'cache');
    }

    // Disable default skill scanning (~/.claude/skills/, project .claude/skills/, etc.)
    // so each agent only loads skills explicitly configured via config.skills.paths/urls.
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = 'true';
    // Disable Claude Code system prompt injection (agents have their own systemPrompt)
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = 'true';
    // Disable project-level config files (agent config is authoritative)
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';
  }

  async start(workspace: string): Promise<void> {
    this.injectEnvForServer();
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
    this.logger?.info(
      `[OpenCode] Registering credentials via sdk.auth.set: ${OpenCodeBackend.redactKeys(this.providerApiKeys)}`,
    );
    for (const [providerID, key] of Object.entries(this.providerApiKeys)) {
      if (key) {
        await this.sdk.auth.set({ providerID, auth: OpenCodeBackend.buildAuth(key) });
        this.logger?.info(`[OpenCode] sdk.auth.set completed for provider: ${providerID}`);
      } else {
        this.logger?.warn(`[OpenCode] Skipping provider ${providerID}: empty key`);
      }
    }

    // Rebuild session map from existing sessions
    // biome-ignore lint/suspicious/noExplicitAny: SDK type is richer than SessionClient interface
    await this.sessionIdMap.init(this.sdk as any);

    // Store workspace for watchdog restarts
    this.workDir = workspace;

    // Start watchdog after successful server startup
    this.startWatchdog(server.url);
  }

  private startWatchdog(serverUrl: string): void {
    this.watchdogHealthUrl = serverUrl;
    this.watchdogInterval = setInterval(async () => {
      try {
        const res = await fetch(`${this.watchdogHealthUrl}/health`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (res.ok) {
          this.watchdogFailureCount = 0;
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      } catch {
        this.watchdogFailureCount++;
        if (this.watchdogFailureCount < this.WATCHDOG_FAILURE_THRESHOLD) return;

        // Check restart cap
        const now = Date.now();
        if (now - this.watchdogWindowStart > this.WATCHDOG_WINDOW_MS) {
          this.watchdogWindowStart = now;
          this.watchdogRestartCount = 0;
        }
        if (this.watchdogRestartCount >= this.WATCHDOG_MAX_RESTARTS) {
          clearInterval(this.watchdogInterval!);
          this.watchdogInterval = null;
          this.sdk = null;
          this.logger?.error(
            '[OpenCode] Watchdog: max restarts exceeded, manual redeploy required',
          );
          return;
        }

        if (this.watchdogRestarting) return;

        this.watchdogRestartCount++;
        this.watchdogFailureCount = 0;
        this.sdk = null;
        this.watchdogRestarting = true;
        try {
          await this.restartWithBackoff();
        } finally {
          this.watchdogRestarting = false;
        }
      }
    }, this.WATCHDOG_POLL_MS);
  }

  private async restartWithBackoff(): Promise<void> {
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000];
    for (let attempt = 0; ; attempt++) {
      const delay = Math.min(delays[attempt] ?? 60_000, 60_000);
      this.logger?.warn(
        `[OpenCode] Watchdog: restarting (attempt ${attempt + 1}), waiting ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        this.injectEnvForServer();
        const port = await findFreePort();
        const server = await createOpencodeServer({
          port,
          config: {
            model: this.config.model,
            ...(this.config.skills && { skills: this.config.skills }),
          },
        });
        this.serverClose?.();
        this.serverClose = () => server.close();
        this.watchdogHealthUrl = server.url;
        const newSdk = createOpencodeClient({
          baseUrl: server.url,
          directory: this.workDir!,
        });

        // Re-register provider API keys
        for (const [providerID, key] of Object.entries(this.providerApiKeys)) {
          if (key) {
            await newSdk.auth.set({ providerID, auth: OpenCodeBackend.buildAuth(key) });
          }
        }

        // Re-initialize the session map
        // biome-ignore lint/suspicious/noExplicitAny: SDK type is richer than SessionClient interface
        await this.sessionIdMap.init(newSdk as any);

        this.sdk = newSdk;
        this.logger?.info('[OpenCode] Watchdog: restart successful');
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.error(`[OpenCode] Watchdog: restart attempt ${attempt + 1} failed: ${msg}`);
      }
    }
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
      parts: [
        { type: 'text', text: state.message },
        ...(state.images?.map((img) => ({
          type: 'image' as const,
          mediaType: img.mediaType,
          data: img.data,
        })) ?? []),
      ],
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
          this.logger?.warn(`[OpenCode] auto-approving permission: ${eventProps.permission}`, {
            patterns: JSON.stringify(eventProps.patterns),
            sessionId,
          });
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
              // The SDK fires multiple 'running' updates per tool call; only emit the
              // first one to avoid duplicating the full input JSON in the renderer's
              // accumulation buffer.
              if (this.emittedToolDeltas.has(part.callID)) return null;
              this.emittedToolDeltas.add(part.callID);
              return { type: 'tool_use_delta', partial_json: JSON.stringify(state.input) };
            }
            if (state.status === 'completed') {
              this.emittedToolDeltas.delete(part.callID);
              return {
                type: 'tool_result',
                id: part.callID,
                name: part.tool,
                content: state.output,
              };
            }
            if (state.status === 'error') {
              this.emittedToolDeltas.delete(part.callID);
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
        // SDK error types nest the message under data.message (e.g. ProviderAuthError, ApiError)
        const msg =
          props.error?.data?.message ??
          props.error?.message ??
          props.error?.name ??
          'Unknown OpenCode error';
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

  /**
   * Update provider API keys at runtime. Calls sdk.auth.set() for each key
   * and updates process.env so watchdog restarts use the new keys.
   */
  async updateCredentials(providerApiKeys: Record<string, string>): Promise<void> {
    this.logger?.info(
      `[OpenCode] updateCredentials called: ${OpenCodeBackend.redactKeys(providerApiKeys)}`,
    );
    this.providerApiKeys = providerApiKeys;
    // Update process.env for watchdog restarts
    for (const [providerID, key] of Object.entries(providerApiKeys)) {
      const envVar = OpenCodeBackend.PROVIDER_ENV_VARS[providerID];
      if (envVar && key) {
        process.env[envVar] = key;
      }
    }
    // Update the running OpenCode server via SDK
    if (this.sdk) {
      for (const [providerID, key] of Object.entries(providerApiKeys)) {
        if (key) {
          await this.sdk.auth.set({ providerID, auth: OpenCodeBackend.buildAuth(key) });
          this.logger?.info(`[OpenCode] sdk.auth.set updated for provider: ${providerID}`);
        }
      }
    } else {
      this.logger?.warn(
        '[OpenCode] updateCredentials: SDK not available, keys stored for next restart only',
      );
    }
  }

  async stop(): Promise<void> {
    // Clear watchdog before killing the process
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
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

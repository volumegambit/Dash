import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { HookCommand, HookEvent, HookMatcherGroup, HooksConfig } from '@dash/plugin-sdk';
import { hookEnv, substituteVars } from './substitute.js';
import type { HookConfigEntry } from './types.js';

// ---------------------------------------------------------------------------
// Public input / decision types (pinned per the task brief).
// ---------------------------------------------------------------------------

export interface ToolPreInput {
  toolName: string;
  toolInput: unknown;
  sessionId?: string;
  cwd?: string;
}
export interface ToolPreDecision {
  block: boolean;
  reason?: string;
  updatedInput?: unknown;
}

export interface ToolPostInput {
  toolName: string;
  toolInput: unknown;
  toolResponse: string;
  sessionId?: string;
  cwd?: string;
}
export interface ToolPostDecision {
  block: boolean;
  reason?: string;
  additionalContext?: string;
}

export interface PromptInput {
  prompt: string;
  sessionId?: string;
  cwd?: string;
}
export interface PromptDecision {
  block: boolean;
  reason?: string;
  additionalContext?: string;
}

export interface LifecycleInput {
  sessionId?: string;
  cwd?: string;
  source?: string;
}
export interface LifecycleResult {
  additionalContext?: string;
}

export interface HookEngine {
  runPreToolUse(input: ToolPreInput): Promise<ToolPreDecision>;
  runPostToolUse(input: ToolPostInput): Promise<ToolPostDecision>;
  runUserPromptSubmit(input: PromptInput): Promise<PromptDecision>;
  runSessionStart(input: LifecycleInput): Promise<LifecycleResult>;
  runStop(input: LifecycleInput): Promise<LifecycleResult>;
  /** any hooks registered at all (lets the backend skip wiring when empty). */
  readonly hasHooks: boolean;
}

export interface HookEngineOptions {
  logger?: { warn(m: string): void };
  /** Fallback per-command timeout in ms when a command/group sets none. */
  defaultTimeoutMs?: number;
  /** Host data dir; used to compute ${CLAUDE_PLUGIN_DATA}. */
  dataDir?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * Cap on combined stdout+stderr bytes buffered per hook run. A runaway (even
 * trusted) hook that floods its output would otherwise grow `outChunks`/
 * `errChunks` unbounded and OOM the gateway — only the timeout bounds it today.
 * On exceeding the cap the child is killed and the outcome fails open (NEUTRAL).
 */
const MAX_HOOK_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Matchers using only these characters are treated as exact / pipe-lists. */
const EXACT_MATCHER = /^[A-Za-z0-9_|]+$/;

// ---------------------------------------------------------------------------
// Internal: the parsed hookSpecificOutput a hook may emit on stdout (exit 0).
// ---------------------------------------------------------------------------

interface HookSpecificOutput {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  updatedInput?: unknown;
  additionalContext?: string;
  /** PostToolUse: `decision: "block"` + `reason` (nested under hookSpecificOutput). */
  decision?: string;
  reason?: string;
}

/** The normalized result of running ONE command hook. */
interface HookOutcome {
  /** Hard stop: a deny/ask/block decision or an exit-2. Halts pre/prompt chains. */
  blocked: boolean;
  reason?: string;
  /** PreToolUse: replacement tool input to thread to the next hook. */
  updatedInput?: unknown;
  /** Post/prompt/lifecycle: context to concatenate. */
  additionalContext?: string;
}

/** Fail-open neutral outcome — contributes no block and no modification. */
const NEUTRAL: HookOutcome = { blocked: false };

/**
 * The Claude Code stdin envelope written to each hook. Field names follow the
 * Claude Code convention (snake_case) so authored hooks are portable.
 */
type StdinPayload = Record<string, unknown>;

export function createHookEngine(
  hookConfigs: HookConfigEntry[],
  opts: HookEngineOptions = {},
): HookEngine {
  const logger = opts.logger;
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dataDir = opts.dataDir ?? process.cwd();

  const hasHooks = hookConfigs.some((hc) =>
    Object.values(hc.config).some((groups) => Array.isArray(groups) && groups.length > 0),
  );

  /** Does `matcher` select `subject`? Absent/''/'*' = match all. */
  function matches(matcher: string | undefined, subject: string): boolean {
    if (matcher === undefined || matcher === '' || matcher === '*') return true;
    if (EXACT_MATCHER.test(matcher)) {
      return matcher.split('|').some((m) => m === subject);
    }
    try {
      return new RegExp(matcher).test(subject);
    } catch (err) {
      logger?.warn(`[hooks] invalid matcher '${matcher}': ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Yields the (entry, command) pairs that fire for `event`, in hookConfigs
   * order, then matcher-group order, then command order. `subjectFor` decides
   * what each group's matcher is tested against (toolName / source / always).
   */
  function* selectHooks(
    event: HookEvent,
    subject: string | undefined,
  ): Generator<{ entry: HookConfigEntry; command: HookCommand }> {
    for (const entry of hookConfigs) {
      const groups: HookMatcherGroup[] | undefined = (entry.config as HooksConfig)[event];
      if (!groups) continue;
      for (const group of groups) {
        // Lifecycle/prompt events match all; tool & SessionStart match the subject.
        const fires = subject === undefined ? true : matches(group.matcher, subject);
        if (!fires) continue;
        for (const command of group.hooks) {
          yield { entry, command };
        }
      }
    }
  }

  /** Per-plugin substitution vars (Claude Code names). */
  function varsFor(entry: HookConfigEntry, cwd: string): Record<string, string> {
    const safeName = entry.pluginName.replace(/[^a-zA-Z0-9_-]/g, '-');
    return {
      CLAUDE_PLUGIN_ROOT: entry.pluginRoot,
      CLAUDE_PLUGIN_DATA: join(dataDir, 'plugins', 'data', safeName),
      CLAUDE_PROJECT_DIR: cwd,
    };
  }

  /**
   * Spawn one command hook and normalize its result. NEVER throws: any spawn
   * error / non-0,2 exit / malformed JSON / timeout returns the NEUTRAL outcome
   * (fail-open) after logging. Exit 2 → blocked with stderr as the reason.
   */
  async function runOne(
    entry: HookConfigEntry,
    command: HookCommand,
    payload: StdinPayload,
    cwd: string,
  ): Promise<HookOutcome> {
    let cmdLine: string;
    let vars: Record<string, string>;
    try {
      vars = varsFor(entry, cwd);
      cmdLine = substituteVars(command.command, vars);
    } catch (err) {
      logger?.warn(`[hooks] ${entry.pluginName}: substitution failed: ${(err as Error).message}`);
      return NEUTRAL;
    }

    const timeoutMs =
      typeof command.timeout === 'number' ? command.timeout * 1000 : defaultTimeoutMs;

    return new Promise<HookOutcome>((resolveOutcome) => {
      let settled = false;
      // Declared with `let` ABOVE settle so a SYNCHRONOUS spawn() throw (whose
      // catch calls settle(NEUTRAL) before the timer is assigned) does not read
      // `timer` in its temporal dead zone — that ReferenceError would reject the
      // promise and defeat the engine's fail-open contract. The `let` (assigned
      // once, later) is intentional: it must be hoisted above `settle`.
      // biome-ignore lint/style/useConst: must be a hoisted `let` to avoid the TDZ described above.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (o: HookOutcome) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolveOutcome(o);
      };

      let child: ReturnType<typeof spawn>;
      try {
        // detached: true puts the child in its own process group so a timeout /
        // output-cap kill can take down the whole group (sh + any descendants),
        // not just the direct `sh` child (which would orphan grandchildren).
        child = spawn('sh', ['-c', cmdLine], {
          cwd,
          env: hookEnv(vars),
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (err) {
        logger?.warn(`[hooks] ${entry.pluginName}: spawn failed: ${(err as Error).message}`);
        return settle(NEUTRAL);
      }

      // Kill the whole process group (negative pid). Falls back to a direct
      // child.kill if the group signal throws (e.g. pid already reaped).
      const killChild = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore — settling NEUTRAL regardless.
          }
        }
      };

      timer = setTimeout(() => {
        logger?.warn(
          `[hooks] ${entry.pluginName}: '${command.command}' timed out after ${timeoutMs}ms — killed (fail-open)`,
        );
        killChild();
        settle(NEUTRAL);
      }, timeoutMs);

      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let totalBytes = 0;
      // Bound buffered output: a runaway hook flooding stdout/stderr would
      // otherwise OOM the host. On exceeding the cap, kill and fail open.
      const onChunk = (chunks: Buffer[], c: Buffer) => {
        if (settled) return;
        chunks.push(c);
        totalBytes += c.length;
        if (totalBytes > MAX_HOOK_OUTPUT_BYTES) {
          logger?.warn(
            `[hooks] ${entry.pluginName}: '${command.command}' exceeded ${MAX_HOOK_OUTPUT_BYTES}-byte output cap — killed (fail-open)`,
          );
          killChild();
          settle(NEUTRAL);
        }
      };
      child.stdout?.on('data', (c: Buffer) => onChunk(outChunks, c));
      child.stderr?.on('data', (c: Buffer) => onChunk(errChunks, c));

      // Swallow async stdin errors (fail-open). If the child doesn't drain stdin
      // and the payload exceeds the OS pipe buffer (~64 KB), or the child exits /
      // is SIGKILLed while a write is pending, the stdin write emits an async
      // EPIPE. Without this listener Node escalates it to uncaughtException and
      // crashes the host. The close/timeout/error handlers settle the outcome.
      child.stdin?.on('error', () => {
        /* fail-open: child closed/ignored stdin; close/timeout handler settles. */
      });

      child.on('error', (err) => {
        logger?.warn(`[hooks] ${entry.pluginName}: spawn error: ${err.message}`);
        settle(NEUTRAL);
      });

      child.on('close', (code) => {
        if (settled) return;
        const stdout = Buffer.concat(outChunks).toString('utf8');
        const stderr = Buffer.concat(errChunks).toString('utf8');

        if (code === 2) {
          // Blocking error: stderr is the reason.
          return settle({ blocked: true, reason: stderr.trim() || undefined });
        }
        if (code !== 0) {
          logger?.warn(
            `[hooks] ${entry.pluginName}: '${command.command}' exited ${code} — fail-open`,
          );
          return settle(NEUTRAL);
        }
        // Exit 0: parse stdout as JSON (empty = no decision).
        settle(parseStdout(stdout, entry, command));
      });

      // Write the event envelope, then close stdin.
      try {
        child.stdin?.end(JSON.stringify(payload));
      } catch (err) {
        logger?.warn(`[hooks] ${entry.pluginName}: stdin write failed: ${(err as Error).message}`);
        killChild();
        settle(NEUTRAL);
      }
    });
  }

  /** Parse an exit-0 hook's stdout into an outcome. Malformed → fail-open. */
  function parseStdout(stdout: string, entry: HookConfigEntry, command: HookCommand): HookOutcome {
    const trimmed = stdout.trim();
    if (!trimmed) return NEUTRAL;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logger?.warn(
        `[hooks] ${entry.pluginName}: '${command.command}' produced non-JSON stdout — fail-open`,
      );
      return NEUTRAL;
    }
    if (typeof parsed !== 'object' || parsed === null) return NEUTRAL;
    const p = parsed as Record<string, unknown>;
    const outcome: HookOutcome = { blocked: false };

    // Top-level decision — used by UserPromptSubmit / Stop / PostToolUse:
    // `{ "decision": "block", "reason": "..." }`, plus the universal
    // `{ "continue": false, "stopReason": "..." }`.
    if (p.decision === 'block' || p.continue === false) {
      outcome.blocked = true;
      if (typeof p.reason === 'string') outcome.reason = p.reason;
      else if (typeof p.stopReason === 'string') outcome.reason = p.stopReason;
    }

    // Event-specific `hookSpecificOutput`: PreToolUse permissionDecision +
    // updatedInput, PostToolUse decision, and additionalContext.
    const hso = p.hookSpecificOutput;
    if (typeof hso === 'object' && hso !== null) {
      const o = hso as HookSpecificOutput;
      // 'ask' is intentionally treated as a conservative block: Dash has no
      // interactive prompt surface to ask the user, so we deny rather than allow.
      if (o.permissionDecision === 'deny' || o.permissionDecision === 'ask') {
        outcome.blocked = true;
        if (typeof o.permissionDecisionReason === 'string') {
          outcome.reason = o.permissionDecisionReason;
        }
      }
      if (o.decision === 'block') {
        outcome.blocked = true;
        if (typeof o.reason === 'string') outcome.reason = o.reason;
      }
      if ('updatedInput' in o && o.updatedInput !== undefined) {
        outcome.updatedInput = o.updatedInput;
      }
      if (typeof o.additionalContext === 'string') {
        outcome.additionalContext = o.additionalContext;
      }
    }
    return outcome;
  }

  /** Concatenate non-empty context fragments with newlines. */
  function joinContext(parts: string[]): string | undefined {
    const kept = parts.filter((p) => p.length > 0);
    return kept.length ? kept.join('\n') : undefined;
  }

  return {
    hasHooks,

    async runPreToolUse(input) {
      const cwd = input.cwd ?? process.cwd();
      let currentInput = input.toolInput;
      for (const { entry, command } of selectHooks('PreToolUse', input.toolName)) {
        const payload: StdinPayload = {
          session_id: input.sessionId,
          cwd,
          hook_event_name: 'PreToolUse',
          tool_name: input.toolName,
          tool_input: currentInput,
        };
        const outcome = await runOne(entry, command, payload, cwd);
        if (outcome.updatedInput !== undefined) currentInput = outcome.updatedInput;
        if (outcome.blocked) {
          return { block: true, reason: outcome.reason };
        }
      }
      const modified = currentInput !== input.toolInput;
      return modified ? { block: false, updatedInput: currentInput } : { block: false };
    },

    async runPostToolUse(input) {
      const cwd = input.cwd ?? process.cwd();
      const contexts: string[] = [];
      for (const { entry, command } of selectHooks('PostToolUse', input.toolName)) {
        const payload: StdinPayload = {
          session_id: input.sessionId,
          cwd,
          hook_event_name: 'PostToolUse',
          tool_name: input.toolName,
          tool_input: input.toolInput,
          tool_response: input.toolResponse,
        };
        const outcome = await runOne(entry, command, payload, cwd);
        if (outcome.additionalContext) contexts.push(outcome.additionalContext);
        if (outcome.blocked) {
          return {
            block: true,
            reason: outcome.reason,
            additionalContext: joinContext(contexts),
          };
        }
      }
      return { block: false, additionalContext: joinContext(contexts) };
    },

    async runUserPromptSubmit(input) {
      const cwd = input.cwd ?? process.cwd();
      const contexts: string[] = [];
      for (const { entry, command } of selectHooks('UserPromptSubmit', undefined)) {
        const payload: StdinPayload = {
          session_id: input.sessionId,
          cwd,
          hook_event_name: 'UserPromptSubmit',
          prompt: input.prompt,
        };
        const outcome = await runOne(entry, command, payload, cwd);
        if (outcome.additionalContext) contexts.push(outcome.additionalContext);
        if (outcome.blocked) {
          return {
            block: true,
            reason: outcome.reason,
            additionalContext: joinContext(contexts),
          };
        }
      }
      return { block: false, additionalContext: joinContext(contexts) };
    },

    async runSessionStart(input) {
      const cwd = input.cwd ?? process.cwd();
      const contexts: string[] = [];
      for (const { entry, command } of selectHooks('SessionStart', input.source)) {
        const payload: StdinPayload = {
          session_id: input.sessionId,
          cwd,
          hook_event_name: 'SessionStart',
          source: input.source,
        };
        const outcome = await runOne(entry, command, payload, cwd);
        if (outcome.additionalContext) contexts.push(outcome.additionalContext);
      }
      return { additionalContext: joinContext(contexts) };
    },

    async runStop(input) {
      const cwd = input.cwd ?? process.cwd();
      const contexts: string[] = [];
      for (const { entry, command } of selectHooks('Stop', undefined)) {
        const payload: StdinPayload = {
          session_id: input.sessionId,
          cwd,
          hook_event_name: 'Stop',
        };
        const outcome = await runOne(entry, command, payload, cwd);
        // NOTE: unlike the pre/prompt events, a Stop hook's block decision
        // (exit 2 / {"decision":"block"}) is intentionally NOT honored. Stop
        // fires from the backend's end-of-turn `finally`, by which point the
        // turn's output has already been streamed to the client — there is
        // nothing left to continue into, so blocking would be a no-op. Only
        // additionalContext is collected.
        if (outcome.additionalContext) contexts.push(outcome.additionalContext);
      }
      return { additionalContext: joinContext(contexts) };
    },
  };
}

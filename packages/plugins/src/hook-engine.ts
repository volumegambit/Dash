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
      const settle = (o: HookOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveOutcome(o);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('sh', ['-c', cmdLine], {
          cwd,
          env: hookEnv(vars),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        logger?.warn(`[hooks] ${entry.pluginName}: spawn failed: ${(err as Error).message}`);
        return settle(NEUTRAL);
      }

      const timer = setTimeout(() => {
        logger?.warn(
          `[hooks] ${entry.pluginName}: '${command.command}' timed out after ${timeoutMs}ms — killed (fail-open)`,
        );
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore — settling NEUTRAL regardless.
        }
        settle(NEUTRAL);
      }, timeoutMs);

      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      child.stdout?.on('data', (c: Buffer) => outChunks.push(c));
      child.stderr?.on('data', (c: Buffer) => errChunks.push(c));

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
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore.
        }
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
    const hso = (parsed as { hookSpecificOutput?: unknown }).hookSpecificOutput;
    if (typeof hso !== 'object' || hso === null) return NEUTRAL;
    const o = hso as HookSpecificOutput;

    const outcome: HookOutcome = { blocked: false };
    if (o.permissionDecision === 'deny' || o.permissionDecision === 'ask') {
      outcome.blocked = true;
      if (typeof o.permissionDecisionReason === 'string') {
        outcome.reason = o.permissionDecisionReason;
      }
    }
    if ('updatedInput' in o && o.updatedInput !== undefined) {
      outcome.updatedInput = o.updatedInput;
    }
    if (typeof o.additionalContext === 'string') {
      outcome.additionalContext = o.additionalContext;
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
        if (outcome.additionalContext) contexts.push(outcome.additionalContext);
      }
      return { additionalContext: joinContext(contexts) };
    },
  };
}

import type { AgentEvent } from '@dash/agent';
import { SentenceChunker } from './chunker.js';

/** A single item of speakable output produced by {@link SpokenRenderer}. */
export type SpeechItem =
  | { kind: 'sentence'; text: string }
  | { kind: 'status'; text: string }
  | { kind: 'question'; text: string; questionId: string };

export interface SpokenRendererOptions {
  /** Clock used for tool-status burst suppression. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Minimum gap, in milliseconds, between two emitted tool-status phrases.
   * A `tool_use_start` that arrives sooner than this after the last
   * *emitted* status is suppressed (emits nothing). Default 8000.
   */
  toolBurstMs?: number;
  /** Chunker used to turn `text_delta` streams into sentences. Defaults to a fresh `SentenceChunker`. */
  chunker?: SentenceChunker;
}

const DEFAULT_TOOL_BURST_MS = 8000;

/** Tool names (post `statusFor` normalization) that report "Looking at the files.". */
const LOOKING_AT_FILES = new Set(['read', 'ls', 'grep', 'glob']);
/** Tool names that report "Making changes.". */
const MAKING_CHANGES = new Set(['write', 'edit']);
/** Tool names that report "Searching the web.". */
const SEARCHING_THE_WEB = new Set(['web_search', 'web_fetch']);

/**
 * Maps a tool name to a short spoken status phrase. Matches case-insensitively
 * after stripping any MCP `server__` prefix (e.g. `filesystem__Read` → `read`,
 * via the tool name's last `__`-separated segment).
 */
function statusFor(name: string): string {
  const lastSeparator = name.lastIndexOf('__');
  const bare = lastSeparator === -1 ? name : name.slice(lastSeparator + 2);
  const key = bare.toLowerCase();

  if (key === 'bash') return 'Running a command.';
  if (LOOKING_AT_FILES.has(key)) return 'Looking at the files.';
  if (MAKING_CHANGES.has(key)) return 'Making changes.';
  if (SEARCHING_THE_WEB.has(key)) return 'Searching the web.';
  if (key === 'agent') return 'Delegating to a sub-agent.';
  return 'Working on it.';
}

/**
 * Turns the `AgentEvent` stream from `@dash/agent` into speech items for a
 * hands-free voice conversation: sentences (via `SentenceChunker`), short
 * tool-status phrases (burst-suppressed so a flurry of tool calls doesn't
 * talk over itself), and questions.
 *
 * One `SpokenRenderer` instance covers one turn: the error status is emitted
 * only once per instance, and tool-status burst suppression is tracked for
 * the instance's lifetime.
 */
export class SpokenRenderer {
  private readonly chunker: SentenceChunker;
  private readonly now: () => number;
  private readonly toolBurstMs: number;

  private lastToolStatusAt: number | null = null;
  private errorEmitted = false;

  constructor(options: SpokenRendererOptions = {}) {
    this.chunker = options.chunker ?? new SentenceChunker();
    this.now = options.now ?? Date.now;
    this.toolBurstMs = options.toolBurstMs ?? DEFAULT_TOOL_BURST_MS;
  }

  event(event: AgentEvent): SpeechItem[] {
    switch (event.type) {
      case 'text_delta':
        return this.chunker.push(event.text).map((text) => ({ kind: 'sentence', text }));

      case 'thinking_delta':
        return [];

      case 'tool_use_start':
        return this.toolStatus(event.name);

      case 'question': {
        const items: SpeechItem[] = this.chunker
          .flush()
          .map((text) => ({ kind: 'sentence', text }) as const);
        const text = event.options.length
          ? `${event.question} ${event.options.join(', or ')}?`
          : event.question;
        items.push({ kind: 'question', text, questionId: event.id });
        return items;
      }

      case 'error':
        return this.errorStatus(event.error);

      case 'response':
        return this.chunker.flush().map((text) => ({ kind: 'sentence', text }));

      default:
        return [];
    }
  }

  /** Flushes any sentence still buffered in the chunker. Idempotent. */
  end(): SpeechItem[] {
    return this.chunker.flush().map((text) => ({ kind: 'sentence', text }));
  }

  private toolStatus(name: string): SpeechItem[] {
    const now = this.now();
    if (this.lastToolStatusAt !== null && now - this.lastToolStatusAt < this.toolBurstMs) {
      return [];
    }
    this.lastToolStatusAt = now;
    return [{ kind: 'status', text: statusFor(name) }];
  }

  private errorStatus(error: Error): SpeechItem[] {
    if (this.errorEmitted) return [];
    this.errorEmitted = true;
    return [{ kind: 'status', text: `Something went wrong. ${error.message || 'Unknown error.'}` }];
  }
}

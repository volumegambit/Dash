import type { ConversationContent, MobileAgentEvent } from '@dash/mobile-contract';
import { type ReactNode, useEffect, useState } from 'react';
import { Markdown } from './Markdown.js';
import {
  type TodoItem,
  formatVisibleDetails,
  isTodoWrite,
  normalizeTool,
  parseTodos,
  resultSummary,
  summarize,
  toolLabel,
} from './tool-presentation.js';

export interface ContentBlocksProps {
  content: ConversationContent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Never-throws fallback for any content/event shape this renderer doesn't
 * (or can't safely) recognize — malformed data from a future server version
 * degrades to this rather than crashing the transcript. */
function UnknownBlock(): ReactNode {
  return (
    <span
      data-testid="unknown-block"
      style={{ color: '#888', fontSize: '0.85em', fontStyle: 'italic' }}
    >
      Unsupported content
    </span>
  );
}

/** Splits `text` on blank lines into one `<p data-testid="text-block">` per
 * paragraph, preserving single newlines within a paragraph. `keyPrefix` is
 * already unique per call site (built from an ever-incrementing counter in
 * `renderAssistantEvents`), so each paragraph's key mixes in its own text
 * rather than its array index — content, not position, identifies it.
 *
 * Used only for plain (non-markdown) text: user messages (spec appendix §6 —
 * user text stays plain) and question prompts (MC's `QuestionBlock` renders
 * the question as a plain paragraph, not through `Markdown`). Assistant
 * reply text uses `<Markdown>` instead — see `flushText` below. */
function renderParagraphs(text: string, keyPrefix: string): ReactNode[] {
  return text
    .split(/\n{2,}/)
    .filter((para) => para.length > 0)
    .map((para, index) => (
      <p
        // Keyed by position, not content: two identical paragraphs in one block
        // (a repeated "..." or a duplicated line) would otherwise collide, and
        // React drops all but the first. `keyPrefix` already carries the
        // flush-order counter, so prefix+index is unique across the message.
        // biome-ignore lint/suspicious/noArrayIndexKey: the rule guards against losing component state when a list reorders; these <p>s are stateless, derived purely from splitting one immutable string, and streaming only appends — a paragraph never changes position once rendered.
        key={`${keyPrefix}-${index}`}
        data-testid="text-block"
        style={{ whiteSpace: 'pre-wrap', margin: '0 0 0.5em' }}
      >
        {para}
      </p>
    ));
}

interface PendingTool {
  name: string;
  input?: Record<string, unknown>;
}

type ToolStatus = 'running' | 'succeeded' | 'failed';

/** Status glyph (spec appendix §3): success = 8px filled green circle,
 * error = 10px red XCircle (drawn inline — apps/web has no icon library
 * dependency, so these stand in for MC's lucide `Circle`/`XCircle`, the same
 * way iOS Task 2 stands SF Symbols in for lucide — see design doc Platform
 * Adaptation 3). `running` has no MC equivalent in ToolBlock itself (MC
 * renders an unresolved tool_use via a separate `tool-progress` element
 * outside ToolBlock); this renderer folds pending tools into the same
 * component (no separate pending/resolved render path), so it needs a third
 * visual state — a spinner, matching the iOS twin's `ProgressView`. */
function ToolStatusGlyph({ status }: { status: ToolStatus }): ReactNode {
  if (status === 'running') {
    return <span className="tool-status-spinner" aria-hidden="true" />;
  }
  if (status === 'failed') {
    return (
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="tool-status-glyph-error"
      >
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <line x1="8.5" y1="8.5" x2="15.5" y2="15.5" stroke="currentColor" strokeWidth="2.5" />
        <line x1="15.5" y1="8.5" x2="8.5" y2="15.5" stroke="currentColor" strokeWidth="2.5" />
      </svg>
    );
  }
  return <span className="tool-status-dot" aria-hidden="true" />;
}

/** Tool result branching (spec appendix §3, ToolResult): error → red
 * pre-wrap text; empty → muted italic "No output"; ≤3 lines → green
 * pre-wrap text; longer → 256px-capped scrollable block on the dark code
 * surface. Diff rendering, directory-listing/numbered-source detection, and
 * TodoWrite's checklist body are out of scope here — same reduced scope as
 * the iOS twin's `resultView` (design doc "Out of scope" + iOS Task 2
 * precedent: brief authoritative over MC's fuller ToolResult.tsx). */
function ToolResultView({ content, isError }: { content: string; isError?: boolean }): ReactNode {
  if (isError) {
    return (
      <p data-testid="tool-result" className="tool-result tool-result-error">
        {content}
      </p>
    );
  }
  if (!content.trim()) {
    return (
      <p data-testid="tool-result" className="tool-result tool-result-empty">
        No output
      </p>
    );
  }
  const lineCount = content.split('\n').length;
  if (lineCount <= 3) {
    return (
      <p data-testid="tool-result" className="tool-result tool-result-short">
        {content}
      </p>
    );
  }
  return (
    <pre data-testid="tool-result" className="tool-result tool-result-long">
      {content}
    </pre>
  );
}

/** A TodoWrite call's checklist.
 *
 * Glyph vocabulary matches Mission Control's `STATUS_INDICATOR` and the iOS
 * `TodoListView`, so the same plan reads identically on all three clients.
 * `data-status` carries the state for styling and for tests, rather than
 * relying on a glyph character. */
function TodoList({ todos }: { todos: TodoItem[] }): ReactNode {
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="tool-todos" data-testid="tool-todos">
      <p className="tool-todos-count">
        {done}/{todos.length} completed
      </p>
      {todos.map((todo) => (
        <div
          key={todo.id ?? todo.content}
          className="tool-todo"
          data-testid="tool-todo-item"
          data-status={todo.status}
        >
          <span className="tool-todo-glyph" aria-hidden="true">
            {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◉' : '○'}
          </span>
          <span className="tool-todo-content">{todo.content}</span>
        </div>
      ))}
    </div>
  );
}

/** MC `ToolBlock` treatment (spec appendix §3): collapsed-by-default card
 * with a status-glyph + mono tool label + inline `summarize()` summary in
 * the header; expanded body shows `formatVisibleDetails` key/value rows
 * followed by the branching result. */
function ToolUseBlock({
  tool,
  result,
}: {
  tool: PendingTool;
  result?: { content: string; isError?: boolean; details?: unknown };
}): ReactNode {
  const todos = isTodoWrite(tool.name) ? parseTodos(tool.input) : null;
  const status: ToolStatus = !result ? 'running' : result.isError ? 'failed' : 'succeeded';
  // Two cards open without being asked. Task cards, because a task list is
  // the agent's plan for the turn — the one tool body read at a glance, and
  // the only one whose contents were not shown at all (`formatDetails`
  // rendered the `todos` array as the literal string "[3 items]"). And
  // failures, because a failure is the one case where the detail is
  // necessary and it was the one case that took a tap to reach. Everything
  // else hides diagnostic detail you want on demand — a command's arguments,
  // a file's contents. Matches iOS `ToolCardView`.
  const [open, setOpen] = useState(todos !== null || status === 'failed');
  // `useState`'s initial value is only read on the FIRST render of this
  // component instance, and a tool card is first rendered while the call is
  // still running — status 'running', so open false. Without this, "failures
  // open by default" would hold for a reloaded transcript and silently not
  // hold live, which is the case that matters. Re-runs only when `status`
  // changes, so a user who collapses a failed card keeps it collapsed.
  useEffect(() => {
    if (status === 'failed') setOpen(true);
  }, [status]);
  const summary = summarize(tool.name, tool.input);
  const outcome = resultSummary(tool.name, result?.content, result?.isError, result?.details);
  const details = formatVisibleDetails(tool.name, tool.input);
  const isBash = normalizeTool(tool.name) === 'bash';

  return (
    <div
      data-testid="tool-use-block"
      data-status={status}
      className={`tool-card${status === 'failed' ? ' tool-card-error' : ''}`}
    >
      <button
        type="button"
        className="tool-card-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ToolStatusGlyph status={status} />
        <span className="tool-card-label">{toolLabel(tool.name)}</span>
        {summary && (
          <span className={`tool-card-summary${isBash ? ' tool-card-summary-mono' : ''}`}>
            {summary}
          </span>
        )}
        {outcome && (
          <span className="tool-card-outcome" data-testid="tool-card-outcome">
            {outcome}
          </span>
        )}
      </button>
      {open && (
        <div className="tool-card-body">
          {todos ? (
            <TodoList todos={todos} />
          ) : (
            details.length > 0 && (
              <div className="tool-card-details">
                {details.map(({ key, value }) => (
                  <p key={key} className="tool-card-detail">
                    <span className="tool-card-detail-key">{key}</span>: {value}
                  </p>
                ))}
              </div>
            )
          )}
          {result && <ToolResultView content={result.content} isError={result.isError} />}
        </div>
      )}
    </div>
  );
}

/** MC `ThinkingBlock` treatment (spec appendix §4): default collapsed,
 * toggle copy exactly "Show thinking"/"Hide thinking", expanded body is
 * plain muted text (not markdown, not italic). Keeps this renderer's
 * existing `<details>`/`<summary>` mechanics (native disclosure, keyboard
 * accessible) rather than switching to MC's own div+button — the native
 * `open` attribute is mirrored into `useState` via `onToggle` so the summary
 * text can react to it. */
function ThinkingBlock({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <details
      data-testid="thinking-block"
      className="thinking-block"
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary className="thinking-summary">{open ? 'Hide thinking' : 'Show thinking'}</summary>
      <p className="thinking-body">{text}</p>
    </details>
  );
}

/**
 * Walks an assistant message's raw `events` array (streamed `text_delta` /
 * `thinking_delta` / `tool_use_start` / `tool_use_delta` / `tool_result` /
 * `response` / `question` — see `packages/agent/src/types.ts` `AgentEvent`
 * and `contracts/mobile/v1/fixtures/chat-stream.jsonl`) into four renderable
 * block kinds: text (rendered via `<Markdown>`), tool-use (collapsed
 * MC-parity tool card), tool-result (nested inside its tool-use card), and
 * thinking (muted, collapsed by default). `tool_use_delta` and `response`
 * are deliberate no-ops (streamed partial input, and an end-of-turn
 * metadata summary that duplicates already-streamed text, respectively —
 * `response` in particular ends *every* real turn, so treating it as
 * unknown would badge every ordinary reply). `question` renders its prompt
 * text as a plain paragraph (no answer affordance here yet, and MC's own
 * `QuestionBlock` doesn't run the question text through markdown either).
 * Anything else — an event type this renderer doesn't know, or a known type
 * with a malformed shape — degrades to `UnknownBlock` rather than throwing.
 */
function renderAssistantEvents(events: MobileAgentEvent[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let key = 0;
  let textBuffer = '';
  let thinkingBuffer = '';
  let pendingTool: PendingTool | null = null;

  const flushText = (): void => {
    if (!textBuffer) return;
    nodes.push(<Markdown key={`text-${key++}`} text={textBuffer} />);
    textBuffer = '';
  };
  const flushThinking = (): void => {
    if (!thinkingBuffer) return;
    nodes.push(<ThinkingBlock key={`think-${key++}`} text={thinkingBuffer} />);
    thinkingBuffer = '';
  };
  /** Flushes an unresolved `pendingTool` (no `tool_result` arrived for it)
   * as an in-progress block — used both when a *new* `tool_use_start`
   * supersedes it and at the end of the event list. */
  const flushPendingToolInProgress = (): void => {
    if (!pendingTool) return;
    nodes.push(<ToolUseBlock key={`tool-${key++}`} tool={pendingTool} />);
    pendingTool = null;
  };
  const pushUnknown = (): void => {
    flushText();
    flushThinking();
    nodes.push(<UnknownBlock key={`unknown-${key++}`} />);
  };

  for (const event of events) {
    if (!isRecord(event) || typeof event.type !== 'string') {
      pushUnknown();
      continue;
    }

    switch (event.type) {
      case 'text_delta': {
        if (typeof event.text !== 'string') {
          pushUnknown();
          break;
        }
        flushThinking();
        textBuffer += event.text;
        break;
      }

      case 'thinking_delta': {
        if (typeof event.text !== 'string') {
          pushUnknown();
          break;
        }
        flushText();
        thinkingBuffer += event.text;
        break;
      }

      case 'tool_use_start': {
        if (typeof event.name !== 'string') {
          pushUnknown();
          break;
        }
        flushText();
        flushThinking();
        flushPendingToolInProgress();
        pendingTool = {
          name: event.name,
          input: isRecord(event.input) ? (event.input as Record<string, unknown>) : undefined,
        };
        break;
      }

      case 'tool_use_delta': {
        // Streamed partial JSON for the tool's input — not rendered
        // directly; the final `input` (from `tool_use_start`) is what's
        // shown, so this is a deliberate no-op rather than unknown content.
        break;
      }

      case 'response': {
        // Emitted once at the end of every real assistant turn (see
        // `packages/agent/src/backends/piagent.ts`) as a metadata summary —
        // its `content` duplicates the text already streamed via
        // `text_delta`, and `usage` has no visual representation here. A
        // deliberate no-op, same treatment as `tool_use_delta`, so an
        // ordinary reply doesn't end in a spurious unknown-content badge.
        break;
      }

      case 'question': {
        // The agent is asking the user something. There's no answer
        // affordance in this surface yet either way, but the question's
        // text is user-facing content worth keeping visible rather than
        // silently dropping — rendered as a plain paragraph alongside the
        // rest of the turn's text.
        if (typeof event.question !== 'string') {
          pushUnknown();
          break;
        }
        flushThinking();
        flushText();
        nodes.push(...renderParagraphs(event.question, `question-${key++}`));
        break;
      }

      case 'tool_result': {
        const content = typeof event.content === 'string' ? event.content : undefined;
        if (content === undefined) {
          pushUnknown();
          break;
        }
        flushText();
        flushThinking();
        const tool = pendingTool ?? (typeof event.name === 'string' ? { name: event.name } : null);
        if (!tool) {
          pushUnknown();
          break;
        }
        nodes.push(
          <ToolUseBlock
            key={`tool-${key++}`}
            tool={tool}
            result={{ content, isError: event.isError === true, details: event.details }}
          />,
        );
        pendingTool = null;
        break;
      }

      default:
        pushUnknown();
    }
  }

  flushText();
  flushThinking();
  flushPendingToolInProgress();

  return nodes;
}

/** Concatenates an assistant message's `text_delta` text (mirrors MC's
 * `extractTextFromEvents`) or a user message's plain text, for the
 * message-level `CopyButton` in `ChatView.tsx`. Deliberately excludes tool
 * output, thinking, and question text — MC's copy button copies "concatenated
 * text only" (spec appendix §6). */
export function getMessageCopyText(content: ConversationContent): string {
  if (!isRecord(content)) return '';
  if (content.type === 'user') {
    return typeof content.text === 'string' ? content.text : '';
  }
  if (content.type === 'assistant') {
    const events = Array.isArray(content.events) ? content.events : [];
    let text = '';
    for (const event of events) {
      if (isRecord(event) && event.type === 'text_delta' && typeof event.text === 'string') {
        text += event.text;
      }
    }
    return text;
  }
  return '';
}

/**
 * Renders one message's `ConversationContent` — `'user'` content as plain
 * text paragraphs (spec appendix §6: user text stays plain, no markdown),
 * `'assistant'` content by walking its raw agent `events` (see
 * `renderAssistantEvents`). Any content that isn't one of those two shapes
 * (e.g. a corrupted payload) degrades to `UnknownBlock` rather than
 * throwing.
 */
export function ContentBlocks({ content }: ContentBlocksProps): ReactNode {
  if (!isRecord(content) || (content.type !== 'user' && content.type !== 'assistant')) {
    return <UnknownBlock />;
  }

  if (content.type === 'user') {
    const text = typeof content.text === 'string' ? content.text : '';
    const images = Array.isArray(content.images) ? content.images : [];
    return (
      <>
        {renderParagraphs(text, 'user-text')}
        {images.length > 0 && (
          // Phase 4 Task 5 (audit #14 remainder): attached images as
          // thumbnails, sourced straight from the contract's base64
          // `MobileImage` (MC parity, chat.tsx `userImages`).
          <div className="user-images">
            {images.map((image, index) => (
              <img
                // biome-ignore lint/suspicious/noArrayIndexKey: images have no id in the contract; order is stable per message
                key={index}
                className="user-image"
                src={`data:${image.mediaType};base64,${image.data}`}
                alt={`Attachment ${index + 1}`}
              />
            ))}
          </div>
        )}
      </>
    );
  }

  const events = Array.isArray(content.events) ? content.events : [];
  return <>{renderAssistantEvents(events)}</>;
}

export default ContentBlocks;

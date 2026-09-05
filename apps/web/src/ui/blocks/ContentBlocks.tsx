import type { ConversationContent, MobileAgentEvent } from '@dash/mobile-contract';
import { type ReactNode, useEffect, useState } from 'react';
import { Markdown } from './Markdown.js';
import {
  type TodoItem,
  bodyIsRedundant,
  diffLines,
  directoryEntries,
  fitsInline,
  formatVisibleDetails,
  grepGroups,
  isTodoWrite,
  normalizeTool,
  parseTodos,
  resultSummary,
  searchResults,
  stripResultChrome,
  summarize,
  toolLabel,
  toolNamespace,
  writtenContent,
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

/** Per-tool-type body (2026-09-05 per-type goal), replacing a branch that
 * keyed only on how many NEWLINES the result contained.
 *
 * Two defects that branch caused, both seen in the gallery: a 1.6 KB
 * single-line `web_fetch` body has no newlines, so it took the "short" path —
 * no height cap, no scroll — and consumed the viewport; and the protocol
 * chrome (`<path>`, `<content>`, `(N entries)`) was printed verbatim. */
function ToolResultView({
  name,
  input,
  content,
  isError,
  details,
}: {
  name: string;
  input?: Record<string, unknown>;
  content: string;
  isError?: boolean;
  details?: unknown;
}): ReactNode {
  if (isError) {
    return (
      <p data-testid="tool-result" className="tool-result tool-result-error">
        {content}
      </p>
    );
  }

  const diff = diffLines(details);
  if (diff.length > 0) {
    // `edit`: the diff IS the result. It rode along in `details.diff` and was
    // thrown away — the body used to read "ok".
    return (
      <div data-testid="tool-diff" className="tool-diff">
        {diff.map((line, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional by nature and this list is immutable once rendered
            key={`${index}-${line.text}`}
            className={`tool-diff-line tool-diff-${line.kind}`}
          >
            {line.text || ' '}
          </span>
        ))}
      </div>
    );
  }

  const normalized = normalizeTool(name);

  if (normalized === 'write') {
    const written = writtenContent(input);
    if (written) {
      return (
        <pre data-testid="tool-result" className="tool-result tool-result-long">
          {written}
        </pre>
      );
    }
  }

  if (normalized === 'ls') {
    const entries = directoryEntries(content);
    if (entries.length > 0) {
      return (
        <ul data-testid="tool-entries" className="tool-entries">
          {entries.map((entry) => (
            <li
              key={entry.name}
              className={entry.isDirectory ? 'tool-entry tool-entry-dir' : 'tool-entry'}
            >
              <span aria-hidden="true" className="tool-entry-glyph">
                {entry.isDirectory ? '▸' : '·'}
              </span>
              {entry.name}
            </li>
          ))}
        </ul>
      );
    }
  }

  if (normalized === 'grep' || normalized === 'find') {
    const groups = grepGroups(content);
    if (groups.length > 0) {
      return (
        <div data-testid="tool-grep" className="tool-grep">
          {groups.map((group) => (
            <div key={group.path} className="tool-grep-group">
              <p className="tool-grep-path">{group.path}</p>
              {group.matches.map((m) => (
                <p key={`${m.line}-${m.text}`} className="tool-grep-match">
                  <span className="tool-grep-line">{m.line}</span>
                  {m.text}
                </p>
              ))}
            </div>
          ))}
        </div>
      );
    }
  }

  if (normalized === 'web_search') {
    const hits = searchResults(content);
    if (hits.length > 0) {
      return (
        <ul data-testid="tool-search-results" className="tool-search-results">
          {hits.map((hit) => (
            <li key={`${hit.host}-${hit.title}`} className="tool-search-result">
              <span className="tool-search-title">{hit.title}</span>
              <span className="tool-search-host">{hit.host}</span>
            </li>
          ))}
        </ul>
      );
    }
  }

  if (bodyIsRedundant(name, content)) return null;

  const body = stripResultChrome(content);
  if (!body) {
    return (
      <p data-testid="tool-result" className="tool-result tool-result-empty">
        No output
      </p>
    );
  }
  if (fitsInline(body)) {
    return (
      <p data-testid="tool-result" className="tool-result tool-result-short">
        {body}
      </p>
    );
  }
  return (
    <pre data-testid="tool-result" className="tool-result tool-result-long">
      {body}
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
  return (
    // No count row: the collapsed header already reads "1/3 done" and the
    // expanded header keeps its summary, so a second "1/3 completed" directly
    // beneath it was the same fact twice.
    <div className="tool-todos" data-testid="tool-todos">
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
  const namespace = toolNamespace(tool.name);
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
        {namespace && <span className="tool-card-namespace">{namespace}</span>}
        <span className="tool-card-label">{toolLabel(tool.name)}</span>
        {summary && (
          <span className={`tool-card-summary${isBash ? ' tool-card-summary-mono' : ''}`}>
            {summary}
          </span>
        )}
        {/* Only while collapsed, matching iOS. Expanded, the body below shows
            the result itself, so a failed card printed its error twice —
            right-aligned in the header and again underneath. */}
        {outcome && !open && (
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
          {/* A task card's body IS the checklist. TodoWrite's own result is the
              string "ok", which rendered as a stray line under the list —
              iOS never showed it, so this was also a client divergence. An
              error still renders, because a failed TodoWrite has something to
              say. */}
          {result && (!todos || result.isError) && (
            <ToolResultView
              name={tool.name}
              input={tool.input}
              content={result.content}
              isError={result.isError}
              details={result.details}
            />
          )}
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

      case 'memory_saved':
      case 'memory_forgotten': {
        // Agent memory bookkeeping (MC parity, chat.tsx's memory chip): a
        // compact chip so the user can see what the agent remembered or
        // forgot. Validated the same way as every other event here — a
        // malformed one degrades to `UnknownBlock` rather than rendering
        // "undefined". Rendered as `<output>` rather than a
        // `<span role="status">` — same implicit status live region, and the
        // form biome's `useSemanticElements` requires.
        const label =
          event.type === 'memory_forgotten'
            ? typeof event.name === 'string'
              ? `Forgot: ${event.name}`
              : null
            : typeof event.description === 'string'
              ? `${event.action === 'updated' ? 'Updated memory' : 'Remembered'}: ${event.description}`
              : null;
        if (label === null) {
          pushUnknown();
          break;
        }
        flushThinking();
        flushText();
        nodes.push(
          <output key={`memory-${key++}`} className="chat-memory-chip">
            {label}
          </output>,
        );
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

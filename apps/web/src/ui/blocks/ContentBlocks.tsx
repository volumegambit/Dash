import type { ConversationContent, MobileAgentEvent } from '@dash/mobile-contract';
import type { ReactNode } from 'react';

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
 * rather than its array index — content, not position, identifies it. */
function renderParagraphs(text: string, keyPrefix: string): ReactNode[] {
  return text
    .split(/\n{2,}/)
    .filter((para) => para.length > 0)
    .map((para) => (
      <p
        key={`${keyPrefix}-${para}`}
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

function ToolUseBlock({
  tool,
  result,
}: {
  tool: PendingTool;
  result?: { content: string; isError?: boolean };
}): ReactNode {
  return (
    <details
      data-testid="tool-use-block"
      style={{
        border: '1px solid #ddd',
        borderRadius: 4,
        padding: '4px 8px',
        margin: '4px 0',
        fontSize: '0.85em',
      }}
    >
      <summary style={{ cursor: 'pointer', fontFamily: 'monospace' }}>
        {tool.name}
        {!result && ' (running…)'}
      </summary>
      {tool.input && Object.keys(tool.input).length > 0 && (
        <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>
          {JSON.stringify(tool.input, null, 2)}
        </pre>
      )}
      {result && (
        <div
          data-testid="tool-result"
          style={{
            whiteSpace: 'pre-wrap',
            margin: '4px 0',
            color: result.isError ? '#b00020' : undefined,
          }}
        >
          {result.content}
        </div>
      )}
    </details>
  );
}

function ThinkingBlock({ text }: { text: string }): ReactNode {
  return (
    <details
      data-testid="thinking-block"
      style={{ color: '#888', fontStyle: 'italic', fontSize: '0.85em', margin: '4px 0' }}
    >
      <summary style={{ cursor: 'pointer' }}>Thinking</summary>
      <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>
    </details>
  );
}

/**
 * Walks an assistant message's raw `events` array (streamed `text_delta` /
 * `thinking_delta` / `tool_use_start` / `tool_use_delta` / `tool_result` /
 * `response` / `question` — see `packages/agent/src/types.ts` `AgentEvent`
 * and `contracts/mobile/v1/fixtures/chat-stream.jsonl`) into four renderable
 * block kinds: text (paragraphs), tool-use (collapsed `<details>` with the
 * tool name), tool-result (nested inside its tool-use's `<details>`), and
 * thinking (muted/italic, collapsed by default). `tool_use_delta` and
 * `response` are deliberate no-ops (streamed partial input, and an
 * end-of-turn metadata summary that duplicates already-streamed text,
 * respectively — `response` in particular ends *every* real turn, so
 * treating it as unknown would badge every ordinary reply). `question`
 * renders its prompt text as a paragraph (no answer affordance here yet).
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
    nodes.push(...renderParagraphs(textBuffer, `text-${key++}`));
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
            result={{ content, isError: event.isError === true }}
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

/**
 * Renders one message's `ConversationContent` — `'user'` content as plain
 * text paragraphs, `'assistant'` content by walking its raw agent `events`
 * (see `renderAssistantEvents`). Any content that isn't one of those two
 * shapes (e.g. a corrupted payload) degrades to `UnknownBlock` rather than
 * throwing.
 */
export function ContentBlocks({ content }: ContentBlocksProps): ReactNode {
  if (!isRecord(content) || (content.type !== 'user' && content.type !== 'assistant')) {
    return <UnknownBlock />;
  }

  if (content.type === 'user') {
    const text = typeof content.text === 'string' ? content.text : '';
    return <>{renderParagraphs(text, 'user-text')}</>;
  }

  const events = Array.isArray(content.events) ? content.events : [];
  return <>{renderAssistantEvents(events)}</>;
}

export default ContentBlocks;

import type { McMessage } from '@dash/mc';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Copy,
  FolderOpen,
  Loader,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Send,
  Square,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

hljs.registerLanguage('bash', bash);
import type { McAgentEvent } from '../../../shared/ipc.js';
import { detectLanguage } from '../components/DiffView.js';
import { Markdown } from '../components/Markdown.js';
import { HighlightedCode, ToolResult } from '../components/ToolResult.js';
import { useAgentsStore } from '../stores/agents.js';
import { useChatStore } from '../stores/chat.js';
import { useConnectorsStore } from '../stores/connectors.js';
import {
  type TodoItem,
  formatDetails,
  isTodoWrite,
  parseTodos,
  summarize,
  toolLabel,
  truncate,
} from './chat.helpers.js';

/** Event types that produce visible rendered output in renderEvents / MessageBubble */
const VISIBLE_EVENT_TYPES = new Set([
  'text_delta',
  'tool_use_start',
  'tool_result',
  'error',
  'question',
]);

// --- Event rendering helpers ---

function renderEvents(
  events: Record<string, unknown>[],
  navigateToLogs?: (timestamp: string) => void,
  onAnswerQuestion?: (questionId: string, answer: string) => void,
  answeredQuestions?: Record<string, string>,
  onNavigateToConnections?: () => void,
): JSX.Element[] {
  const elements: JSX.Element[] = [];
  let blockCount = 0;
  let textBuffer = '';
  let thinkingBuffer = '';
  let toolName = '';
  let toolInput: Record<string, unknown> | undefined;
  let toolOutputBuffer = '';

  for (let i = 0; i < events.length; i++) {
    const event = events[i] as McAgentEvent;

    if (event.type === 'thinking_delta') {
      thinkingBuffer += event.text;
    } else if (event.type === 'text_delta') {
      // Flush thinking before text
      if (thinkingBuffer) {
        elements.push(<ThinkingBlock key={`think-${blockCount++}`} text={thinkingBuffer} />);
        thinkingBuffer = '';
      }
      textBuffer += event.text;
    } else if (event.type === 'tool_use_start') {
      // Flush text before tool
      if (textBuffer) {
        elements.push(
          <div key={`text-${blockCount++}`} className="mb-3">
            <Markdown>{textBuffer}</Markdown>
          </div>,
        );
        textBuffer = '';
      }
      toolName = event.name;
      toolInput = event.input;
      toolOutputBuffer = '';
    } else if (event.type === 'tool_use_delta') {
      toolOutputBuffer += event.partial_json;
    } else if (event.type === 'tool_result') {
      const inputJson = toolInput ? JSON.stringify(toolInput) : '';
      elements.push(
        <ToolBlock
          key={`tool-${blockCount++}`}
          name={toolName || event.name}
          input={inputJson}
          result={event.content}
          isError={event.isError}
          toolDetails={event.details}
        />,
      );
      toolName = '';
      toolInput = undefined;
      toolOutputBuffer = '';
    } else if (event.type === 'question') {
      // Flush text before question
      if (textBuffer) {
        elements.push(
          <div key={`text-${blockCount++}`} className="mb-3">
            <Markdown>{textBuffer}</Markdown>
          </div>,
        );
        textBuffer = '';
      }
      elements.push(
        <QuestionBlock
          key={`question-${blockCount++}`}
          id={event.id}
          question={event.question}
          options={event.options ?? []}
          answer={answeredQuestions?.[event.id]}
          onAnswer={onAnswerQuestion}
        />,
      );
    } else if (event.type === 'error') {
      const msg =
        typeof event.error === 'string'
          ? event.error
          : ((event.error as unknown as { message?: string })?.message ?? 'Unknown error');
      const timestamp = typeof event.timestamp === 'string' ? event.timestamp : undefined;
      const isAuthError =
        msg.includes('401') ||
        msg.includes('403') ||
        msg.toLowerCase().includes('authentication') ||
        msg.toLowerCase().includes('unauthorized') ||
        /invalid.*key/i.test(msg);
      elements.push(
        <div key={`err-${blockCount++}`} className="mb-3 text-red">
          <div className="flex items-center gap-2">
            <span>{msg}</span>
            {navigateToLogs && timestamp && (
              <button
                type="button"
                onClick={() => navigateToLogs(timestamp)}
                className="text-xs text-muted underline hover:text-foreground"
              >
                View logs →
              </button>
            )}
          </div>
          {isAuthError && onNavigateToConnections && (
            <div className="mt-1">
              <button
                type="button"
                onClick={onNavigateToConnections}
                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                Update Key →
              </button>
            </div>
          )}
        </div>,
      );
    }
  }

  // Flush remaining
  if (thinkingBuffer) elements.push(<ThinkingBlock key="think-final" text={thinkingBuffer} />);
  if (textBuffer)
    elements.push(
      <div key="text-final" className="mb-3">
        <Markdown>{textBuffer}</Markdown>
      </div>,
    );
  // Flush in-progress tool call (tool_use_start seen but no tool_result yet)
  if (toolName) {
    const inProgressSummary = toolInput ? summarize(toolName, JSON.stringify(toolInput)) : '';
    const isBashInProgress = toolName === 'bash' || toolName === 'execute_command';
    let inProgressHtml: string | null = null;
    if (isBashInProgress && inProgressSummary) {
      try {
        inProgressHtml = hljs.highlight(inProgressSummary, { language: 'bash' }).value;
      } catch {
        /* ignore */
      }
    }
    let inProgressNode: React.ReactNode = null;
    if (inProgressSummary && inProgressHtml) {
      inProgressNode = (
        <span
          className="ml-1 font-mono text-muted"
          dangerouslySetInnerHTML={{ __html: inProgressHtml }}
        />
      );
    } else if (inProgressSummary) {
      inProgressNode = <span className="ml-1 text-muted">{inProgressSummary}</span>;
    }
    elements.push(
      <div
        key="tool-progress"
        className="mb-2 flex items-center gap-2 border border-border bg-sidebar-hover px-3 py-1.5 text-xs text-muted"
      >
        <Loader size={12} className="animate-spin shrink-0" />
        <span className="font-mono">{toolLabel(toolName)}</span>
        {inProgressNode}
      </div>,
    );
  }

  return elements;
}

function ThinkingIndicator(): JSX.Element {
  return (
    <div className="mb-4 flex items-center gap-2 py-2 text-xs text-muted">
      <Loader size={12} className="animate-spin" />
      <span>Thinking…</span>
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2 border border-border bg-sidebar-hover">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-1.5 text-left text-xs text-muted hover:text-foreground"
      >
        {open ? 'Hide' : 'Show'} thinking
      </button>
      {open && <p className="px-3 pb-2 text-xs text-muted whitespace-pre-wrap">{text}</p>}
    </div>
  );
}

function QuestionBlock({
  id,
  question,
  options,
  answer,
  onAnswer,
}: {
  id: string;
  question: string;
  options: string[];
  answer?: string;
  onAnswer?: (questionId: string, answer: string) => void;
}): JSX.Element {
  const [inputValue, setInputValue] = useState('');
  const answered = answer != null;

  if (answered) {
    return (
      <div className="mb-2 border border-border bg-sidebar-hover px-3 py-1.5 text-xs">
        <span className="text-muted">Question</span>
        <span className="ml-1">{answer}</span>
        <span className="ml-1 text-green">✓</span>
      </div>
    );
  }

  return (
    <div className="mb-2 border border-accent/50 bg-accent/5 px-3 py-2 text-sm">
      <p className="mb-2">❓ {question}</p>
      {options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => onAnswer?.(id, opt)}
              className="border border-border bg-card-bg px-3 py-1.5 text-xs transition-colors hover:bg-card-hover hover:border-accent"
            >
              {opt}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = inputValue.trim();
            if (trimmed) onAnswer?.(id, trimmed);
          }}
        >
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Type your answer…"
            className="flex-1 border border-border bg-card-bg px-3 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={!inputValue.trim()}
            className="bg-accent px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
          >
            Reply
          </button>
        </form>
      )}
    </div>
  );
}

const STATUS_INDICATOR: Record<string, { icon: string; label: string; color: string }> = {
  completed: { icon: '✓', label: 'Done', color: 'text-green' },
  in_progress: { icon: '◉', label: 'In progress', color: 'text-accent' },
  pending: { icon: '○', label: 'Pending', color: 'text-muted' },
};

function TodoListBlock({ todos }: { todos: TodoItem[] }): JSX.Element {
  const counts = { completed: 0, total: todos.length };
  for (const t of todos) if (t.status === 'completed') counts.completed++;

  return (
    <div className="space-y-1">
      <p className="mb-1.5 text-muted">
        {counts.completed}/{counts.total} completed
      </p>
      {todos.map((todo) => {
        const st = STATUS_INDICATOR[todo.status] ?? STATUS_INDICATOR.pending;
        return (
          <div key={todo.id ?? todo.content} className="flex items-start gap-2">
            <span className={`mt-px ${st.color}`}>{st.icon}</span>
            <span className={todo.status === 'completed' ? 'line-through text-muted' : ''}>
              {todo.content}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ToolBlock({
  name,
  input,
  result,
  isError,
  toolDetails,
}: {
  name: string;
  input: string;
  result: string;
  isError?: boolean;
  toolDetails?: unknown;
}): JSX.Element {
  const hasDiff =
    name === 'edit' &&
    toolDetails != null &&
    typeof toolDetails === 'object' &&
    'diff' in toolDetails;
  const [open, setOpen] = useState(hasDiff);
  const [showRaw, setShowRaw] = useState(false);
  const summary = summarize(name, input);
  const normalizedName = name === 'read_file' ? 'read' : name;
  const isBash = normalizedName === 'bash' || name === 'execute_command';
  const isWrite = normalizedName === 'write' || name === 'write_file';
  const READ_HIDDEN_KEYS = new Set(['path', 'offset', 'limit']);
  const allDetails = formatDetails(input);
  const details =
    normalizedName === 'read'
      ? allDetails.filter(({ key }) => !READ_HIDDEN_KEYS.has(key))
      : isWrite
        ? allDetails.filter(({ key }) => key !== 'content')
        : allDetails;
  const todos = isTodoWrite(name) ? parseTodos(input) : null;

  // Parse Write tool content for rich display
  const writeContent = useMemo(() => {
    if (!isWrite || !input) return null;
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      if (typeof parsed.content !== 'string') return null;
      const filePath = typeof parsed.path === 'string' ? parsed.path : undefined;
      const ext = filePath?.split('.').pop()?.toLowerCase();

      // Detect render mode from file extension
      if (ext === 'md' || ext === 'mdx') {
        return { content: parsed.content, mode: 'markdown' as const };
      }
      if (ext === 'svg') {
        // Sanitize SVG: strip script tags and event handlers
        const parser = new DOMParser();
        const doc = parser.parseFromString(parsed.content, 'image/svg+xml');
        for (const el of doc.querySelectorAll('script')) el.remove();
        for (const el of doc.querySelectorAll('*')) {
          for (const attr of [...el.attributes]) {
            if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
          }
        }
        const svg = doc.querySelector('svg');
        const sanitized = svg ? svg.outerHTML : parsed.content;
        return { content: sanitized, mode: 'svg' as const };
      }
      if (ext === 'json') {
        // Pretty-print if not already formatted
        try {
          const obj = JSON.parse(parsed.content);
          return { content: JSON.stringify(obj, null, 2), mode: 'code' as const, language: 'json' };
        } catch {
          return { content: parsed.content, mode: 'code' as const, language: 'json' };
        }
      }

      const lang = filePath ? detectLanguage(filePath) : undefined;
      return { content: parsed.content, mode: 'code' as const, language: lang };
    } catch {
      return null;
    }
  }, [isWrite, input]);

  // For Read tool: extract path from result XML as fallback when input is empty
  const effectiveSummary = useMemo(() => {
    if (summary) return summary;
    if (normalizedName === 'read' && result) {
      const pathMatch = result.match(/<path>(.*?)<\/path>/s);
      if (pathMatch?.[1]) return truncate(pathMatch[1]);
    }
    return '';
  }, [summary, normalizedName, result]);
  const highlightedSummary = useMemo(() => {
    if (!isBash || !effectiveSummary) return null;
    try {
      return hljs.highlight(effectiveSummary, { language: 'bash' }).value;
    } catch {
      return null;
    }
  }, [isBash, effectiveSummary]);

  let summaryNode: React.ReactNode = null;
  if (effectiveSummary && highlightedSummary) {
    summaryNode = (
      <span
        className="ml-1 font-mono text-muted"
        dangerouslySetInnerHTML={{ __html: highlightedSummary }}
      />
    );
  } else if (effectiveSummary) {
    summaryNode = <span className="ml-1 text-muted">{effectiveSummary}</span>;
  }

  return (
    <div
      className={`mb-3 border text-xs ${isError ? 'border-red-900/50 bg-red-900/10' : 'border-border bg-sidebar-hover'}`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-1.5 text-left hover:text-foreground"
      >
        {isError ? (
          <XCircle size={10} className="inline text-red mr-1.5" />
        ) : (
          <Circle size={8} className="inline text-green fill-green mr-1.5" />
        )}
        <span className="font-mono">{toolLabel(name)}</span>
        {summaryNode}
      </button>
      {open && (
        <div className="border-t border-border px-3 pb-2 pt-1">
          {todos ? (
            <>
              <TodoListBlock todos={todos} />
              <button
                type="button"
                onClick={() => setShowRaw((r) => !r)}
                className="mt-2 text-[10px] text-muted hover:text-foreground"
              >
                {showRaw ? 'Hide raw' : 'Show raw'}
              </button>
              {showRaw && <pre className="mt-1 whitespace-pre-wrap text-muted">{input}</pre>}
            </>
          ) : (
            <>
              {input && !hasDiff && (
                <div className="mb-1 space-y-0.5">
                  {details.map(({ key, value }) => (
                    <p key={key} className="text-muted">
                      <span className="capitalize">{key}:</span> {value}
                    </p>
                  ))}
                </div>
              )}
              {writeContent?.mode === 'markdown' ? (
                <div className="max-h-64 overflow-auto prose-sm">
                  <Markdown>{writeContent.content}</Markdown>
                </div>
              ) : writeContent?.mode === 'svg' ? (
                <div className="max-h-64 overflow-auto bg-white/5 p-2 flex items-center justify-center">
                  <div dangerouslySetInnerHTML={{ __html: writeContent.content }} />
                </div>
              ) : writeContent?.mode === 'code' ? (
                <div className="max-h-64 overflow-auto bg-[#161b22] p-2">
                  {writeContent.language ? (
                    <HighlightedCode
                      content={writeContent.content}
                      language={writeContent.language}
                    />
                  ) : (
                    <pre className="overflow-x-auto whitespace-pre text-foreground/80">
                      {writeContent.content}
                    </pre>
                  )}
                </div>
              ) : (
                <ToolResult
                  name={name}
                  input={input}
                  result={result}
                  isError={isError}
                  details={toolDetails}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function extractUsage(events: Record<string, unknown>[]): Record<string, number> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as McAgentEvent;
    if (e.type === 'response' && e.usage) return e.usage;
  }
  return null;
}

/** Extract plain text from assistant events for copying */
function extractTextFromEvents(events: Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const event of events) {
    const e = event as McAgentEvent;
    if (e.type === 'text_delta') parts.push(e.text);
  }
  return parts.join('');
}

function CopyButton({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="p-1 text-muted/50 hover:text-foreground transition-colors"
      title="Copy message"
    >
      {copied ? <Check size={14} className="text-green" /> : <Copy size={14} />}
    </button>
  );
}

const MessageBubble = memo(function MessageBubble({
  message,
  streamingEvents,
  navigateToLogs,
  onAnswerQuestion,
  answeredQuestions,
  onNavigateToConnections,
}: {
  message?: McMessage;
  streamingEvents?: McAgentEvent[];
  navigateToLogs?: (timestamp: string) => void;
  onAnswerQuestion?: (questionId: string, answer: string) => void;
  answeredQuestions?: Record<string, string>;
  onNavigateToConnections?: () => void;
}): JSX.Element {
  const isUser = message?.role === 'user';

  if (isUser && message) {
    const userText =
      message.content.type === 'user' && message.content.text ? message.content.text : '';
    const userImages = message.content.type === 'user' ? message.content.images : undefined;
    return (
      <div className="group mb-6 flex items-start justify-end gap-1">
        <div className="opacity-0 group-hover:opacity-100 transition-opacity mt-3">
          {userText && <CopyButton text={userText} />}
        </div>
        <div className="bg-[#141414] border-l-[3px] border-l-accent text-foreground p-3 max-w-[85%] text-sm">
          {userText && <p className="whitespace-pre-wrap">{userText}</p>}
          {userImages && userImages.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {userImages.map((img, i) => (
                <img
                  key={`img-${img.mediaType}-${img.data.slice(0, 16)}-${i}`}
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt={`Attached ${i + 1}`}
                  className="max-h-48 max-w-full"
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const events: Record<string, unknown>[] =
    streamingEvents ?? (message?.content.type === 'assistant' ? message.content.events : []);
  const rendered = renderEvents(
    events,
    navigateToLogs,
    onAnswerQuestion,
    answeredQuestions,
    onNavigateToConnections,
  );
  const usage = extractUsage(events);
  const assistantText = extractTextFromEvents(events);

  const isLive = streamingEvents != null;

  // Don't render an empty bubble — show nothing (the streaming ThinkingIndicator handles the waiting state)
  if (rendered.length === 0) return <></>;

  return (
    <div className="group mb-6">
      <div className="bg-[#141414] border-2 border-border p-3 w-fit max-w-[95%] text-sm text-foreground [&>*:last-child]:mb-0">
        {rendered}
        {isLive && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted">
            <Loader size={12} className="animate-spin" />
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 max-w-[80%] px-1">
        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
          {assistantText && <CopyButton text={assistantText} />}
        </div>
        {usage && (
          <div className="font-[family-name:var(--font-mono)] text-[10px] text-muted opacity-60">
            {usage.input_tokens != null && <span>{formatTokens(usage.input_tokens)} in</span>}
            {usage.input_tokens != null && usage.output_tokens != null && <span> · </span>}
            {usage.output_tokens != null && <span>{formatTokens(usage.output_tokens)} out</span>}
          </div>
        )}
      </div>
    </div>
  );
});

/** Extract the latest TodoWrite state from messages and live streaming events */
function extractLatestTodos(msgs: McMessage[], liveEvents: McAgentEvent[]): TodoItem[] | null {
  let latest: TodoItem[] | null = null;

  // Scan persisted messages (newest last)
  for (const msg of msgs) {
    if (msg.content.type !== 'assistant') continue;
    let toolName = '';
    let toolInputJson = '';
    for (const event of msg.content.events as McAgentEvent[]) {
      if (event.type === 'tool_use_start') {
        toolName = event.name;
        toolInputJson = event.input ? JSON.stringify(event.input) : '';
      } else if (event.type === 'tool_result') {
        if (isTodoWrite(toolName || event.name)) {
          const parsed = parseTodos(toolInputJson);
          if (parsed) latest = parsed;
        }
        toolName = '';
        toolInputJson = '';
      }
    }
  }

  // Check live streaming events (override if newer)
  let liveName = '';
  let liveInputJson = '';
  for (const event of liveEvents) {
    if (event.type === 'tool_use_start') {
      liveName = event.name;
      liveInputJson = event.input ? JSON.stringify(event.input) : '';
    } else if (event.type === 'tool_result') {
      if (isTodoWrite(liveName || event.name)) {
        const parsed = parseTodos(liveInputJson);
        if (parsed) latest = parsed;
      }
      liveName = '';
      liveInputJson = '';
    }
  }

  // Also check in-progress todowrite (not yet completed)
  if (isTodoWrite(liveName) && liveInputJson) {
    const parsed = parseTodos(liveInputJson);
    if (parsed) latest = parsed;
  }

  return latest;
}

function PinnedTodoPanel({ todos }: { todos: TodoItem[] }): JSX.Element {
  const completed = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  const progressPct = todos.length > 0 ? (completed / todos.length) * 100 : 0;
  const allDone = completed === todos.length;
  const [collapsed, setCollapsed] = useState(allDone);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return <></>;

  return (
    <div className="border-t border-border bg-card-bg">
      <div className="flex w-full items-center justify-between px-6 py-2 text-xs text-muted">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex flex-1 items-center justify-between hover:text-foreground"
        >
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-muted">Tasks</span>
            <span className="font-medium">
              Tasks: {completed}/{todos.length} completed
              {inProgress > 0 && ` · ${inProgress} in progress`}
            </span>
            {collapsed &&
              (() => {
                const active = todos.find((t) => t.status === 'in_progress');
                return active ? (
                  <span className="text-accent font-normal truncate">— {active.content}</span>
                ) : null;
              })()}
          </span>
          {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        {allDone && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="ml-2 p-0.5 hover:bg-border hover:text-foreground"
            title="Dismiss task list"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="px-6 pb-3">
          {/* Progress bar */}
          <div className="mb-2 h-1 rounded-full bg-border">
            <div
              className="h-1 rounded-full bg-green-500 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          <div className="max-h-40 space-y-1 overflow-y-auto text-xs">
            {todos.map((todo) => {
              const isActive = todo.status === 'in_progress';
              const isDone = todo.status === 'completed';

              return (
                <div
                  key={todo.id ?? todo.content}
                  className={`flex items-center gap-2 px-2 py-1 ${
                    isActive ? 'bg-accent/10 border border-accent/30' : ''
                  }`}
                >
                  <span className={STATUS_INDICATOR[todo.status]?.color ?? 'text-muted'}>
                    {STATUS_INDICATOR[todo.status]?.icon ?? '○'}
                  </span>
                  <span
                    className={`flex-1 ${isDone ? 'line-through text-muted' : ''} ${isActive ? 'text-accent' : ''}`}
                  >
                    {todo.content}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const ConversationItem = memo(function ConversationItem({
  conversation,
  isSelected,
  hasUnread,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: { id: string; title: string; agentName: string };
  isSelected: boolean;
  hasUnread: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startRename = useCallback(() => {
    setEditValue(conversation.title);
    setEditing(true);
    setConfirmingDelete(false);
  }, [conversation.title]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== conversation.title) {
      onRename(trimmed);
    }
    setEditing(false);
  }, [editValue, conversation.title, onRename]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <li className="px-4 py-2">
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={commitRename}
          className="w-full border border-accent bg-card-bg px-2 py-1 text-xs text-foreground focus:outline-none"
        />
      </li>
    );
  }

  return (
    <li
      className={`group flex items-start justify-between transition-colors hover:bg-sidebar-hover cursor-pointer ${
        isSelected ? 'bg-[#141414] border-l-[3px] border-l-accent' : 'border-b border-border'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={startRename}
        className={`min-w-0 flex-1 px-4 py-3.5 text-left ${
          isSelected ? 'text-foreground' : 'text-muted'
        }`}
      >
        <p className="truncate font-[family-name:var(--font-display)] text-sm font-semibold text-foreground flex items-center gap-1.5">
          {hasUnread && <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-green" />}
          {conversation.title}
        </p>
        <p className="truncate font-[family-name:var(--font-mono)] text-[10px] text-accent">
          {conversation.agentName}
        </p>
      </button>
      <div className="mr-2 mt-2 flex shrink-0 items-center gap-0.5">
        {confirmingDelete ? (
          <>
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(false);
                onDelete();
              }}
              className="p-0.5 text-red hover:bg-red-900/30"
              aria-label="Confirm delete"
            >
              <Check size={10} />
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="p-0.5 text-muted hover:bg-sidebar-hover"
              aria-label="Cancel delete"
            >
              <X size={10} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={startRename}
              className="opacity-0 transition-opacity group-hover:opacity-100 p-0.5 text-muted hover:text-foreground"
              aria-label={`Rename conversation ${conversation.title}`}
            >
              <Pencil size={10} />
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="opacity-0 transition-opacity group-hover:opacity-100 p-0.5 text-muted hover:text-red"
              aria-label={`Delete conversation ${conversation.title}`}
            >
              <Trash2 size={10} />
            </button>
          </>
        )}
      </div>
    </li>
  );
});

function formatModelName(model: string): string {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-5" → "claude-sonnet-4-5")
  const name = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  return name;
}

// --- Agent Selection Modal ---

function AgentSelectionModal({
  agents,
  onSelect,
  onClose,
  defaultAgent,
}: {
  agents: { agentId: string; agentName: string }[];
  onSelect: (agentId: string) => void;
  onClose: () => void;
  defaultAgent?: { agentId: string } | null;
}): JSX.Element {
  const defaultIndex = defaultAgent
    ? Math.max(
        0,
        agents.findIndex((a) => a.agentId === defaultAgent.agentId),
      )
    : 0;
  const [selectedIndex, setSelectedIndex] = useState(defaultIndex);
  const [searchTerm, setSearchTerm] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filtered = searchTerm.trim()
    ? agents.filter((a) => a.agentName.toLowerCase().includes(searchTerm.toLowerCase()))
    : agents;

  // Focus search input on mount
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Reset selection when filter changes (skip initial render)
  const isInitialRender = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: searchTerm is the trigger, not a used value
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }
    setSelectedIndex(0);
  }, [searchTerm]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          onSelect(filtered[selectedIndex].agentId);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, selectedIndex, onSelect, onClose],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click to close */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className="relative z-10 w-[400px] border border-border bg-surface shadow-2xl"
        onKeyDown={handleKeyDown}
      >
        <div className="border-b border-border px-4 py-3">
          <p className="mb-2 font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[3px] text-accent">
            Select Agent
          </p>
          <div className="flex items-center gap-2 bg-[#141414] border border-border px-3 py-2">
            <Search size={14} className="text-muted shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search agents…"
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none"
            />
          </div>
          <p className="mt-2 text-[10px] text-muted font-[family-name:var(--font-mono)]">
            ↑↓ to navigate · Enter to select · Esc to cancel
          </p>
        </div>
        <ul className="max-h-[300px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-4 py-3 text-xs text-muted">No agents found.</li>
          ) : (
            filtered.map((agent, i) => (
              <li key={agent.agentId}>
                <button
                  type="button"
                  onClick={() => onSelect(agent.agentId)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={`w-full text-left px-4 py-2.5 transition-colors ${
                    i === selectedIndex
                      ? 'bg-[#141414] border-l-[3px] border-l-accent'
                      : 'border-b border-border text-muted hover:bg-sidebar-hover'
                  }`}
                >
                  <p className="font-[family-name:var(--font-display)] text-sm font-semibold text-foreground">
                    {agent.agentName}
                  </p>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

// --- Main Chat component ---

export function Chat(): JSX.Element {
  const search = Route.useSearch();
  const { agents, loadAgents } = useAgentsStore();
  const {
    conversations,
    selectedConversationId,
    messages,
    streamingEvents,
    sending,
    unreadConversations,
    loadAllConversations,
    selectConversation,
    createConversation,
    renameConversation,
    deleteConversation,
    sendMessage,
    cancelMessage,
  } = useChatStore();

  const connectors = useConnectorsStore((s) => s.connectors);

  const navigate = useNavigate();
  const activeAgents = agents.filter((a) => a.status === 'active' || a.status === 'registered');
  const [input, setInput] = useState('');
  const [attachedImages, setAttachedImages] = useState<
    { id: string; preview: string; mediaType: string; data: string }[]
  >([]);
  const [answeredQuestions, setAnsweredQuestions] = useState<Record<string, string>>({});
  const [imageError, setImageError] = useState<string | null>(null);
  const [conversationSearch, setConversationSearch] = useState('');
  const [showAgentModal, setShowAgentModal] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Resolve the agent for the selected conversation
  const selectedConversation = selectedConversationId
    ? conversations.find((c) => c.id === selectedConversationId)
    : null;
  const selectedAgentId = selectedConversation?.agentId ?? '';

  const navigateToLogs = useCallback(
    (timestamp: string) => {
      if (!selectedAgentId) return;
      navigate({
        to: '/agents/$id',
        params: { id: selectedAgentId },
        search: { tab: 'monitor' },
      });
    },
    [selectedAgentId, navigate],
  );

  const handleAnswerQuestion = useCallback(
    async (questionId: string, answer: string) => {
      if (!selectedConversationId) return;
      setAnsweredQuestions((prev) => ({ ...prev, [questionId]: answer }));
      try {
        await window.api.chatAnswerQuestion(selectedConversationId, questionId, answer);
      } catch (err) {
        console.error('[Chat] Failed to answer question:', err);
      }
    },
    [selectedConversationId],
  );

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Load all conversations on mount
  useEffect(() => {
    loadAllConversations();
  }, [loadAllConversations]);

  // Load connectors and subscribe to status changes
  useEffect(() => {
    useConnectorsStore.getState().loadConnectors();
    const unsub = useConnectorsStore.getState().initConnectorListeners();
    return unsub;
  }, []);

  // Scroll to bottom on new messages
  const selectedMessages = selectedConversationId ? (messages[selectedConversationId] ?? []) : [];
  const isStreaming = selectedConversationId ? (sending[selectedConversationId] ?? false) : false;
  const liveEvents = selectedConversationId ? (streamingEvents[selectedConversationId] ?? []) : [];

  // Track previous message count to distinguish bulk loads from incremental updates
  const prevMessageCount = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);

  // Track whether user is scrolled near the bottom of the message area
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Consider "near bottom" if within 150px of the bottom
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: messagesEndRef is a stable ref
  useEffect(() => {
    // Bulk load (conversation switched): always jump instantly to bottom
    const isBulkLoad = prevMessageCount.current === 0 && selectedMessages.length > 0;
    prevMessageCount.current = selectedMessages.length;
    if (isBulkLoad) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
      isNearBottom.current = true;
    } else if (isNearBottom.current) {
      // Only auto-scroll if user is already near the bottom
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [selectedMessages.length, liveEvents.length]);

  // Reset message count tracking when conversation changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset on conversation change
  useEffect(() => {
    prevMessageCount.current = 0;
    isNearBottom.current = true;
  }, [selectedConversationId]);

  // Build available agents list from active agents
  const availableAgents = useMemo(
    () =>
      activeAgents.map((a) => ({
        agentId: a.id,
        agentName: a.name,
      })),
    [activeAgents],
  );

  const handleNewConversation = useCallback(() => {
    if (availableAgents.length === 0) return;
    setShowAgentModal(true);
  }, [availableAgents]);

  const handleAgentSelected = useCallback(
    async (agentId: string) => {
      setShowAgentModal(false);
      try {
        const conv = await createConversation(agentId);
        await selectConversation(conv.id);
      } catch (err) {
        console.error('[Chat] Failed to create conversation:', err);
      }
    },
    [createConversation, selectConversation],
  );

  // Keyboard shortcut: Cmd+N / Ctrl+N for new conversation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        handleNewConversation();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleNewConversation]);

  // If navigated with search params, auto-create conversation — intentionally run once on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally run once on mount
  useEffect(() => {
    if (search.agentId) {
      createConversation(search.agentId)
        .then((conv) => selectConversation(conv.id))
        .catch((err) => console.error('[Chat] Failed to create conversation from search:', err));
    }
  }, []);

  // Auto-focus textarea when a conversation is selected (e.g. after creating a new one)
  useEffect(() => {
    if (selectedConversationId) {
      // Small delay to ensure the textarea is enabled after render
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [selectedConversationId]);

  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, []);

  const addImageFiles = useCallback((files: FileList | File[]) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const maxSize = 5 * 1024 * 1024;
    setImageError(null);
    const valid = Array.from(files).filter((f) => allowedTypes.includes(f.type));
    if (valid.length === 0 && files.length > 0) {
      setImageError('Unsupported image type. Use PNG, JPG, GIF, or WebP.');
      return;
    }
    for (const file of valid) {
      if (file.size > maxSize) {
        setImageError('Image must be under 5MB.');
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1];
        setAttachedImages((prev) => {
          if (prev.length >= 4) {
            setImageError('Maximum 4 images per message.');
            return prev;
          }
          return [
            ...prev,
            { id: crypto.randomUUID(), preview: dataUrl, mediaType: file.type, data: base64 },
          ];
        });
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const removeImage = useCallback((id: string) => {
    setAttachedImages((prev) => prev.filter((img) => img.id !== id));
    setImageError(null);
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text && attachedImages.length === 0) return;
    if (!selectedConversationId || isStreaming) return;
    const images =
      attachedImages.length > 0
        ? attachedImages.map(({ mediaType, data }) => ({ mediaType, data }))
        : undefined;
    setInput('');
    setAttachedImages([]);
    setImageError(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    try {
      await sendMessage(selectedConversationId, text, images);
    } catch (err) {
      console.error('[Chat] Failed to send message:', err);
      // Note: store already clears sending flag on error
    }
  }, [input, attachedImages, selectedConversationId, isStreaming, sendMessage]);

  // Resolve model for the selected conversation's agent
  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const mcpIssue = useMemo(() => {
    if (!selectedAgent) return null;
    const mcpNames = selectedAgent.config.mcpServers ?? [];
    for (const name of mcpNames) {
      const connector = connectors.find((c: { name: string; status: string }) => c.name === name);
      if (!connector) continue;
      if (connector.status === 'needs_reauth') {
        return { serverName: name, status: 'needs_reauth' as const };
      }
      if (connector.status === 'error' || connector.status === 'disconnected') {
        return { serverName: name, status: connector.status };
      }
    }
    return null;
  }, [selectedAgent, connectors]);
  const activeModel = selectedAgent?.config.model;
  const activeWorkspace = selectedAgent?.config.workspace;

  const latestTodos = useMemo(
    () => extractLatestTodos(selectedMessages, liveEvents),
    [selectedMessages, liveEvents],
  );

  // Enrich conversations with agent names resolved from the agents store
  const enrichedConversations = useMemo(
    () =>
      conversations.map((c) => {
        const agent = agents.find((a) => a.id === c.agentId);
        return { ...c, agentName: agent?.name ?? '' };
      }),
    [conversations, agents],
  );

  const filteredConversations = useMemo(
    () =>
      conversationSearch.trim()
        ? enrichedConversations.filter(
            (c) =>
              c.title.toLowerCase().includes(conversationSearch.toLowerCase()) ||
              c.agentName.toLowerCase().includes(conversationSearch.toLowerCase()),
          )
        : enrichedConversations,
    [enrichedConversations, conversationSearch],
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page Header */}
      <div className="bg-surface px-8 py-4 border-b border-border flex justify-between items-center shrink-0">
        <div>
          <span className="font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[3px] text-accent">
            Conversations
          </span>
          <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
            Chat
          </h1>
        </div>
        <button
          type="button"
          onClick={handleNewConversation}
          disabled={availableAgents.length === 0}
          className="inline-flex items-center gap-2 bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-40"
          title="New conversation (⌘N)"
        >
          <Plus size={14} />
          New conversation
          <kbd className="text-[10px] font-medium text-white/80 bg-white/15 border border-white/25 px-1.5 py-0.5">
            ⌘N
          </kbd>
        </button>
      </div>

      {showAgentModal && (
        <AgentSelectionModal
          agents={availableAgents}
          onSelect={handleAgentSelected}
          onClose={() => setShowAgentModal(false)}
          defaultAgent={selectedConversation ? { agentId: selectedConversation.agentId } : null}
        />
      )}

      <div className="flex flex-1 min-h-0">
        {/* Left: Conversation List */}
        <div className="w-[300px] bg-surface border-r border-border flex flex-col shrink-0 overflow-hidden">
          {/* Search bar */}
          <div className="px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2 bg-[#141414] border border-border px-3 py-2">
              <Search size={14} className="text-muted shrink-0" />
              <input
                type="text"
                value={conversationSearch}
                onChange={(e) => setConversationSearch(e.target.value)}
                placeholder="Search conversations…"
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none"
              />
            </div>
          </div>

          {/* Conversation list */}
          <ul className="flex-1 overflow-y-auto">
            {filteredConversations.length === 0 ? (
              <li className="px-4 py-3.5 text-xs text-muted">
                {conversations.length === 0 ? 'No conversations yet.' : 'No results.'}
              </li>
            ) : (
              filteredConversations.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conversation={conv}
                  isSelected={conv.id === selectedConversationId}
                  hasUnread={unreadConversations.has(conv.id)}
                  onSelect={() => selectConversation(conv.id)}
                  onRename={(title) => renameConversation(conv.id, title)}
                  onDelete={() => deleteConversation(conv.id)}
                />
              ))
            )}
          </ul>
        </div>

        {/* Right: Chat Panel */}
        <div
          className="flex flex-1 flex-col min-h-0 min-w-0"
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files.length > 0) addImageFiles(e.dataTransfer.files);
          }}
          onDragOver={(e) => e.preventDefault()}
        >
          {(activeModel || selectedConversation) && (
            <div className="flex items-center gap-3 border-b border-border px-6 py-1.5 shrink-0">
              {selectedAgent && (
                <span className="text-xs font-medium text-accent">{selectedAgent.name}</span>
              )}
              {activeModel && (
                <span className="text-xs text-muted">{formatModelName(activeModel)}</span>
              )}
              {activeWorkspace && (
                <div className="ml-auto flex items-center gap-4">
                  <button
                    type="button"
                    onClick={() => window.api.openPath(activeWorkspace)}
                    className="flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-foreground"
                    title={`Workspace: ${activeWorkspace}`}
                  >
                    <FolderOpen size={12} />
                    <span className="max-w-[300px] truncate">{activeWorkspace}</span>
                  </button>
                </div>
              )}
            </div>
          )}

          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-4"
          >
            {!selectedConversationId ? (
              <p className="text-center text-sm text-muted mt-8">
                {activeAgents.length === 0
                  ? 'Deploy an agent first, then come back to chat.'
                  : 'Select a conversation or press ⌘N to start a new one.'}
              </p>
            ) : (
              <>
                {selectedMessages.map((msg, i) => (
                  <MessageBubble
                    key={`${msg.role}-${i}`}
                    message={msg}
                    navigateToLogs={navigateToLogs}
                    onAnswerQuestion={handleAnswerQuestion}
                    answeredQuestions={answeredQuestions}
                    onNavigateToConnections={() => navigate({ to: '/connections' })}
                  />
                ))}
                {isStreaming && !liveEvents.some((e) => VISIBLE_EVENT_TYPES.has(e.type)) && (
                  <ThinkingIndicator />
                )}
                {isStreaming && liveEvents.some((e) => VISIBLE_EVENT_TYPES.has(e.type)) && (
                  <MessageBubble
                    streamingEvents={liveEvents}
                    navigateToLogs={navigateToLogs}
                    onAnswerQuestion={handleAnswerQuestion}
                    answeredQuestions={answeredQuestions}
                    onNavigateToConnections={() => navigate({ to: '/connections' })}
                  />
                )}
              </>
            )}
            <div ref={messagesEndRef} />
          </div>

          {latestTodos && latestTodos.length > 0 && <PinnedTodoPanel todos={latestTodos} />}

          {/* MCP connector warning banner */}
          {mcpIssue && (
            <div className="bg-yellow-900/30 border-t border-yellow-700/50 px-6 py-3 flex items-center justify-between shrink-0">
              <span className="text-sm text-yellow-200">
                {mcpIssue.status === 'needs_reauth'
                  ? `${mcpIssue.serverName} connector needs re-authorization`
                  : `${mcpIssue.serverName} connector is offline`}
              </span>
              <button
                type="button"
                onClick={async () => {
                  if (mcpIssue.status === 'needs_reauth') {
                    await window.api.mcpReauthorize(mcpIssue.serverName);
                  } else {
                    await window.api.mcpReconnectConnector(mcpIssue.serverName);
                  }
                }}
                className="border border-yellow-700/50 bg-yellow-900/40 px-3 py-1 text-xs text-yellow-200 hover:bg-yellow-900/60"
              >
                {mcpIssue.status === 'needs_reauth' ? 'Re-authorize' : 'Reconnect'}
              </button>
            </div>
          )}

          {/* Input bar */}
          <div className="bg-surface border-t border-border px-6 py-4 flex items-center gap-3 shrink-0">
            <div className="flex-1 flex flex-col gap-2">
              {attachedImages.length > 0 && (
                <div className="flex gap-2">
                  {attachedImages.map((img) => (
                    <div key={img.id} className="relative">
                      <img
                        src={img.preview}
                        alt="Attached"
                        className="h-16 w-16 border border-border object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeImage(img.id)}
                        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-900 text-[10px] text-white hover:bg-red-700"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {imageError && <p className="text-xs text-red">{imageError}</p>}
              <form
                className="flex items-center gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSend();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files.length > 0) addImageFiles(e.dataTransfer.files);
                }}
                onDragOver={(e) => e.preventDefault()}
              >
                <textarea
                  ref={textareaRef}
                  rows={1}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    resizeTextarea();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  onPaste={(e) => {
                    const files = Array.from(e.clipboardData.items)
                      .filter((item) => item.kind === 'file')
                      .map((item) => item.getAsFile())
                      .filter((f): f is File => f !== null);
                    if (files.length > 0) addImageFiles(files);
                  }}
                  placeholder={
                    selectedConversationId ? 'Type a message…' : 'Select a conversation first'
                  }
                  disabled={!selectedConversationId || isStreaming}
                  className="flex-1 bg-[#141414] border border-border px-4 py-3 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50 resize-none"
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) addImageFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!selectedConversationId || isStreaming}
                  className="border border-border p-2.5 text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground disabled:opacity-50 shrink-0"
                  title="Attach image"
                >
                  <Paperclip size={16} />
                </button>
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={() => selectedConversationId && cancelMessage(selectedConversationId)}
                    className="bg-red-900/50 p-2.5 text-red transition-colors hover:bg-red-900/70 shrink-0"
                  >
                    <Square size={16} />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={
                      (!input.trim() && attachedImages.length === 0) || !selectedConversationId
                    }
                    className="bg-accent text-white p-2.5 hover:bg-primary-hover disabled:opacity-50 transition-colors shrink-0"
                  >
                    <Send size={16} />
                  </button>
                )}
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/chat')({
  validateSearch: (search: Record<string, unknown>) => ({
    agentId: typeof search.agentId === 'string' ? search.agentId : '',
  }),
  component: Chat,
});

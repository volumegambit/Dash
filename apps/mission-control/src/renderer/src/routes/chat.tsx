import type { McMessage } from '@dash/mc';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Loader,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { McAgentEvent } from '../../../shared/ipc.js';
import { Markdown } from '../components/Markdown.js';
import { ToolResult } from '../components/ToolResult.js';
import { useChatStore } from '../stores/chat.js';
import { useDeploymentsStore } from '../stores/deployments.js';
import {
  type TodoItem,
  formatDetails,
  isTodoWrite,
  parseTodos,
  summarize,
  toolIcon,
  toolLabel,
} from './chat.helpers.js';

// --- Event rendering helpers ---

function renderEvents(
  events: Record<string, unknown>[],
  navigateToLogs?: (timestamp: string) => void,
): JSX.Element[] {
  const elements: JSX.Element[] = [];
  let blockCount = 0;
  let textBuffer = '';
  let thinkingBuffer = '';
  let toolName = '';
  let toolInputBuffer = '';

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
          <div key={`text-${blockCount++}`}>
            <Markdown>{textBuffer}</Markdown>
          </div>,
        );
        textBuffer = '';
      }
      toolName = event.name;
      toolInputBuffer = '';
    } else if (event.type === 'tool_use_delta') {
      toolInputBuffer += event.partial_json;
    } else if (event.type === 'tool_result') {
      elements.push(
        <ToolBlock
          key={`tool-${blockCount++}`}
          name={toolName || event.name}
          input={toolInputBuffer}
          result={event.content}
          isError={event.isError}
        />,
      );
      toolName = '';
      toolInputBuffer = '';
    } else if (event.type === 'error') {
      const msg =
        typeof event.error === 'string'
          ? event.error
          : ((event.error as unknown as { message?: string })?.message ?? 'Unknown error');
      const timestamp = typeof event.timestamp === 'string' ? event.timestamp : undefined;
      elements.push(
        <div key={`err-${blockCount++}`} className="flex items-center gap-2 text-red-400">
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
        </div>,
      );
    }
  }

  // Flush remaining
  if (thinkingBuffer) elements.push(<ThinkingBlock key="think-final" text={thinkingBuffer} />);
  if (textBuffer)
    elements.push(
      <div key="text-final">
        <Markdown>{textBuffer}</Markdown>
      </div>,
    );
  // Flush in-progress tool call (tool_use_start seen but no tool_result yet)
  if (toolName) {
    const inProgressSummary = toolInputBuffer ? summarize(toolName, toolInputBuffer) : '';
    elements.push(
      <div key="tool-progress" className="mb-2 text-xs text-muted">
        {toolIcon(toolName)} <span className="font-mono">{toolLabel(toolName)}</span>
        {inProgressSummary && <span className="ml-1">→ {inProgressSummary}</span>}
        {' …'}
      </div>,
    );
  }

  return elements;
}

function ThinkingBlock({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2 rounded border border-border bg-sidebar-hover">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-1.5 text-left text-xs text-muted hover:text-foreground"
      >
        💭 {open ? 'Hide' : 'Show'} thinking
      </button>
      {open && <p className="px-3 pb-2 text-xs text-muted whitespace-pre-wrap">{text}</p>}
    </div>
  );
}

const STATUS_INDICATOR: Record<string, { icon: string; label: string; color: string }> = {
  completed: { icon: '✓', label: 'Done', color: 'text-green-400' },
  in_progress: { icon: '◉', label: 'In progress', color: 'text-blue-400' },
  pending: { icon: '○', label: 'Pending', color: 'text-muted' },
};

const PRIORITY_BADGE: Record<string, { label: string; cls: string }> = {
  high: { label: 'High', cls: 'bg-red-900/30 text-red-300' },
  medium: { label: 'Med', cls: 'bg-yellow-900/30 text-yellow-300' },
  low: { label: 'Low', cls: 'bg-zinc-700/40 text-zinc-400' },
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
        const pr = todo.priority ? PRIORITY_BADGE[todo.priority] : undefined;
        return (
          <div key={todo.id ?? todo.content} className="flex items-start gap-2">
            <span className={`mt-px ${st.color}`}>{st.icon}</span>
            <span className={todo.status === 'completed' ? 'line-through text-muted' : ''}>
              {todo.content}
            </span>
            {pr && (
              <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] ${pr.cls}`}>
                {pr.label}
              </span>
            )}
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
}: { name: string; input: string; result: string; isError?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const icon = toolIcon(name);
  const summary = summarize(name, input);
  const details = formatDetails(input);
  const todos = isTodoWrite(name) ? parseTodos(input) : null;

  return (
    <div
      className={`mb-2 rounded border text-xs ${isError ? 'border-red-900/50 bg-red-900/10' : 'border-border bg-sidebar-hover'}`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-1.5 text-left hover:text-foreground"
      >
        {icon} <span className="font-mono">{toolLabel(name)}</span>
        {summary && <span className="ml-1 text-muted">→ {summary}</span>}
        {isError ? ' ✗' : ' ✓'}
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
              {input && (
                <div className="mb-1 space-y-0.5">
                  {details.map(({ key, value }) => (
                    <p key={key} className="text-muted">
                      <span className="capitalize">{key}:</span> {value}
                    </p>
                  ))}
                </div>
              )}
              <ToolResult name={name} result={result} isError={isError} />
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

function MessageBubble({
  message,
  streamingEvents,
  navigateToLogs,
}: {
  message?: McMessage;
  streamingEvents?: McAgentEvent[];
  navigateToLogs?: (timestamp: string) => void;
}): JSX.Element {
  const isUser = message?.role === 'user';

  if (isUser && message) {
    const userImages = message.content.type === 'user' ? message.content.images : undefined;
    return (
      <div className="mb-4 flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-primary px-4 py-2 text-sm text-white">
          {message.content.type === 'user' && message.content.text && (
            <p className="whitespace-pre-wrap">{message.content.text}</p>
          )}
          {userImages && userImages.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {userImages.map((img, i) => (
                <img
                  key={`img-${img.mediaType}-${img.data.slice(0, 16)}-${i}`}
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt={`Attached ${i + 1}`}
                  className="max-h-48 max-w-full rounded"
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
  const usage = extractUsage(events);

  return (
    <div className="mb-4">
      <div className="max-w-[80%] px-4 py-2 text-sm text-foreground">
        {renderEvents(events, navigateToLogs)}
      </div>
      {usage && (
        <div className="mt-1 max-w-[80%] px-1 text-[10px] text-muted/60">
          {usage.input_tokens != null && <span>{formatTokens(usage.input_tokens)} in</span>}
          {usage.input_tokens != null && usage.output_tokens != null && <span> · </span>}
          {usage.output_tokens != null && <span>{formatTokens(usage.output_tokens)} out</span>}
        </div>
      )}
    </div>
  );
}

/** Extract the latest TodoWrite state from messages and live streaming events */
function extractLatestTodos(msgs: McMessage[], liveEvents: McAgentEvent[]): TodoItem[] | null {
  let latest: TodoItem[] | null = null;

  // Scan persisted messages (newest last)
  for (const msg of msgs) {
    if (msg.content.type !== 'assistant') continue;
    let toolName = '';
    let toolInput = '';
    for (const event of msg.content.events as McAgentEvent[]) {
      if (event.type === 'tool_use_start') {
        toolName = event.name;
        toolInput = '';
      } else if (event.type === 'tool_use_delta') {
        toolInput += event.partial_json;
      } else if (event.type === 'tool_result') {
        if (isTodoWrite(toolName || event.name)) {
          const parsed = parseTodos(toolInput);
          if (parsed) latest = parsed;
        }
        toolName = '';
        toolInput = '';
      }
    }
  }

  // Check live streaming events (override if newer)
  let liveName = '';
  let liveInput = '';
  for (const event of liveEvents) {
    if (event.type === 'tool_use_start') {
      liveName = event.name;
      liveInput = '';
    } else if (event.type === 'tool_use_delta') {
      liveInput += event.partial_json;
    } else if (event.type === 'tool_result') {
      if (isTodoWrite(liveName || event.name)) {
        const parsed = parseTodos(liveInput);
        if (parsed) latest = parsed;
      }
      liveName = '';
      liveInput = '';
    }
  }

  // Also check in-progress todowrite (not yet completed)
  if (isTodoWrite(liveName) && liveInput) {
    const parsed = parseTodos(liveInput);
    if (parsed) latest = parsed;
  }

  return latest;
}

function PinnedTodoPanel({ todos }: { todos: TodoItem[] }): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const completed = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  const progressPct = todos.length > 0 ? (completed / todos.length) * 100 : 0;

  return (
    <div className="border-t border-border bg-sidebar-bg">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between px-6 py-2 text-xs text-muted hover:text-foreground"
      >
        <span className="flex items-center gap-2">
          <span>📋</span>
          <span className="font-medium">
            Tasks: {completed}/{todos.length} completed
            {inProgress > 0 && ` · ${inProgress} in progress`}
          </span>
        </span>
        {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

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
              const pr = todo.priority ? PRIORITY_BADGE[todo.priority] : undefined;

              return (
                <div
                  key={todo.id ?? todo.content}
                  className={`flex items-center gap-2 rounded px-2 py-1 ${
                    isActive ? 'bg-blue-900/20 border border-blue-800/40' : ''
                  }`}
                >
                  <span className={STATUS_INDICATOR[todo.status]?.color ?? 'text-muted'}>
                    {STATUS_INDICATOR[todo.status]?.icon ?? '○'}
                  </span>
                  <span
                    className={`flex-1 ${isDone ? 'line-through text-muted' : ''} ${isActive ? 'text-blue-300' : ''}`}
                  >
                    {todo.content}
                  </span>
                  {pr && (
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${pr.cls}`}>
                      {pr.label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ConversationItem({
  conversation,
  isSelected,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: { id: string; title: string; agentName: string };
  isSelected: boolean;
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
          className="w-full rounded border border-primary bg-sidebar-bg px-2 py-1 text-xs text-foreground focus:outline-none"
        />
      </li>
    );
  }

  return (
    <li
      className={`group flex items-start justify-between transition-colors hover:bg-sidebar-hover ${
        isSelected ? 'bg-sidebar-hover' : ''
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={startRename}
        className={`min-w-0 flex-1 px-4 py-2 text-left text-xs ${
          isSelected ? 'text-foreground' : 'text-muted'
        }`}
      >
        <p className="truncate font-medium">{conversation.title}</p>
        <p className="truncate text-muted/60">{conversation.agentName}</p>
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
              className="rounded p-0.5 text-red-400 hover:bg-red-900/30"
              aria-label="Confirm delete"
            >
              <Check size={10} />
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="rounded p-0.5 text-muted hover:bg-sidebar-hover"
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
              className="opacity-0 transition-opacity group-hover:opacity-100 rounded p-0.5 text-muted hover:text-foreground"
              aria-label={`Rename conversation ${conversation.title}`}
            >
              <Pencil size={10} />
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="opacity-0 transition-opacity group-hover:opacity-100 rounded p-0.5 text-muted hover:text-red-400"
              aria-label={`Delete conversation ${conversation.title}`}
            >
              <Trash2 size={10} />
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function formatModelName(model: string): string {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-5" → "claude-sonnet-4-5")
  const name = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  return name;
}

// --- Main Chat component ---

export function Chat(): JSX.Element {
  const search = Route.useSearch();
  const { deployments, loadDeployments } = useDeploymentsStore();
  const {
    conversations,
    selectedConversationId,
    messages,
    streamingEvents,
    sending,
    loadConversations,
    selectConversation,
    createConversation,
    renameConversation,
    deleteConversation,
    sendMessage,
    cancelMessage,
  } = useChatStore();

  const navigate = useNavigate();
  const runningDeployments = deployments.filter((d) => d.status === 'running');
  const [selectedDeploymentId, setSelectedDeploymentId] = useState(search.deploymentId || '');
  const [selectedAgentName, setSelectedAgentName] = useState(search.agentName || '');
  const [input, setInput] = useState('');
  const [attachedImages, setAttachedImages] = useState<
    { id: string; preview: string; mediaType: string; data: string }[]
  >([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const navigateToLogs = useCallback(
    (timestamp: string) => {
      if (!selectedDeploymentId) return;
      navigate({
        to: '/agents/$id',
        params: { id: selectedDeploymentId },
        search: { tab: 'logs', since: timestamp, level: 'error' },
      });
    },
    [selectedDeploymentId, navigate],
  );

  useEffect(() => {
    loadDeployments();
  }, [loadDeployments]);

  // Auto-select first running deployment
  useEffect(() => {
    if (!selectedDeploymentId && runningDeployments.length > 0) {
      setSelectedDeploymentId(runningDeployments[0].id);
    }
  }, [selectedDeploymentId, runningDeployments]);

  // Load conversations when deployment changes
  useEffect(() => {
    if (!selectedDeploymentId) return;
    loadConversations(selectedDeploymentId);
  }, [selectedDeploymentId, loadConversations]);

  // Auto-select first agent when deployment changes
  useEffect(() => {
    if (!selectedDeploymentId) return;
    const dep = deployments.find((d) => d.id === selectedDeploymentId);
    if (dep?.config.agents) {
      const agentNames = Object.keys(dep.config.agents);
      if (agentNames.length > 0 && !selectedAgentName) {
        setSelectedAgentName(agentNames[0]);
      }
    }
  }, [selectedDeploymentId, deployments, selectedAgentName]);

  // Scroll to bottom on new messages
  const selectedMessages = selectedConversationId ? (messages[selectedConversationId] ?? []) : [];
  const isStreaming = selectedConversationId ? (sending[selectedConversationId] ?? false) : false;
  const liveEvents = selectedConversationId ? (streamingEvents[selectedConversationId] ?? []) : [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: messagesEndRef is a stable ref
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selectedMessages.length, liveEvents.length]);

  const handleNewConversation = useCallback(async () => {
    if (!selectedDeploymentId || !selectedAgentName) return;
    try {
      const conv = await createConversation(selectedDeploymentId, selectedAgentName);
      await selectConversation(conv.id);
    } catch (err) {
      console.error('[Chat] Failed to create conversation:', err);
    }
  }, [selectedDeploymentId, selectedAgentName, createConversation, selectConversation]);

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

  const selectedDeployment = deployments.find((d) => d.id === selectedDeploymentId);
  const agentNames = selectedDeployment?.config.agents
    ? Object.keys(selectedDeployment.config.agents)
    : [];
  const agentConfig =
    selectedDeployment?.config?.agents?.[selectedAgentName] ?? selectedDeployment?.config?.agent;
  const activeModel = agentConfig?.model;

  return (
    <div className="-m-8 flex flex-1 overflow-hidden">
      {/* Left panel: conversation list */}
      <div className="flex w-64 flex-col border-r border-border">
        <div className="border-b border-border px-4 py-3">
          {/* Deployment picker */}
          {runningDeployments.length > 1 && (
            <select
              value={selectedDeploymentId}
              onChange={(e) => {
                setSelectedDeploymentId(e.target.value);
                setSelectedAgentName('');
              }}
              className="mb-2 w-full rounded border border-border bg-sidebar-bg px-2 py-1 text-xs text-foreground focus:outline-none"
            >
              {runningDeployments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
          {/* Agent picker */}
          {agentNames.length > 1 && (
            <select
              value={selectedAgentName}
              onChange={(e) => setSelectedAgentName(e.target.value)}
              className="mb-2 w-full rounded border border-border bg-sidebar-bg px-2 py-1 text-xs text-foreground focus:outline-none"
            >
              {agentNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={handleNewConversation}
            disabled={!selectedDeploymentId || !selectedAgentName}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground disabled:opacity-40"
          >
            <Plus size={12} />
            New conversation
          </button>
        </div>

        <ul className="flex-1 overflow-y-auto py-2">
          {conversations.length === 0 ? (
            <li className="px-4 text-xs text-muted">No conversations yet.</li>
          ) : (
            conversations.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isSelected={conv.id === selectedConversationId}
                onSelect={() => selectConversation(conv.id)}
                onRename={(title) => renameConversation(conv.id, title)}
                onDelete={() => deleteConversation(conv.id)}
              />
            ))
          )}
        </ul>
      </div>

      {/* Right panel: message thread */}
      <div className="flex flex-1 flex-col">
        {!selectedConversationId && (
          <div className="border-b border-border px-6 py-4">
            <h1 className="text-2xl font-bold">Chat</h1>
            <p className="mt-1 text-sm text-muted">Select or create a conversation</p>
          </div>
        )}

        {activeModel && (
          <div className="flex items-center justify-between border-b border-border px-6 py-1.5">
            <span className="text-xs text-muted">{formatModelName(activeModel)}</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!selectedConversationId ? (
            <p className="text-center text-sm text-muted">
              {runningDeployments.length === 0
                ? 'Deploy an agent first, then come back to chat.'
                : 'Select a conversation or create a new one.'}
            </p>
          ) : (
            <>
              {selectedMessages.map((msg, i) => (
                <MessageBubble
                  key={`${msg.role}-${i}`}
                  message={msg}
                  navigateToLogs={navigateToLogs}
                />
              ))}
              {isStreaming && liveEvents.length === 0 && (
                <div className="mb-4 flex items-center gap-2 text-sm text-muted">
                  <Loader size={14} className="animate-spin" />
                  Thinking…
                </div>
              )}
              {isStreaming && liveEvents.length > 0 && (
                <MessageBubble streamingEvents={liveEvents} navigateToLogs={navigateToLogs} />
              )}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>

        {(() => {
          const todos = extractLatestTodos(selectedMessages, liveEvents);
          return todos && todos.length > 0 ? <PinnedTodoPanel todos={todos} /> : null;
        })()}

        <div className="border-t border-border px-6 py-4">
          {attachedImages.length > 0 && (
            <div className="mb-2 flex gap-2">
              {attachedImages.map((img) => (
                <div key={img.id} className="relative">
                  <img
                    src={img.preview}
                    alt="Attached"
                    className="h-16 w-16 rounded border border-border object-cover"
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
          {imageError && <p className="mb-1 text-xs text-red-400">{imageError}</p>}
          <form
            className="flex gap-2"
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
              className="flex-1 resize-none rounded-lg border border-border bg-sidebar-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none disabled:opacity-50"
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
              className="rounded-lg border border-border px-2 py-2 text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground disabled:opacity-50"
              title="Attach image"
            >
              <Paperclip size={16} />
            </button>
            {isStreaming ? (
              <button
                type="button"
                onClick={() => selectedConversationId && cancelMessage(selectedConversationId)}
                className="rounded-lg bg-red-900/50 px-4 py-2 text-sm text-red-400 transition-colors hover:bg-red-900/70"
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={(!input.trim() && attachedImages.length === 0) || !selectedConversationId}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
              >
                <Send size={16} />
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/chat')({
  validateSearch: (search: Record<string, unknown>) => ({
    deploymentId: typeof search.deploymentId === 'string' ? search.deploymentId : '',
    agentName: typeof search.agentName === 'string' ? search.agentName : '',
  }),
  component: Chat,
});

import type { McMessage } from '@dash/mc';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Loader, Plus, Send, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { McAgentEvent } from '../../../shared/ipc.js';
import { Markdown } from '../components/Markdown.js';
import { useChatStore } from '../stores/chat.js';
import { useDeploymentsStore } from '../stores/deployments.js';
import {
  type TodoItem,
  formatDetails,
  isTodoWrite,
  parseTodos,
  summarize,
  toolIcon,
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
        {toolIcon(toolName)} <span className="font-mono">{toolName}</span>
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
        {icon} <span className="font-mono">{name}</span>
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
              <p
                className={`whitespace-pre-wrap ${isError ? 'text-red-400' : 'text-green-400/80'}`}
              >
                {result}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
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
    return (
      <div className="mb-4 flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-primary px-4 py-2 text-sm text-white">
          <p className="whitespace-pre-wrap">
            {message.content.type === 'user' ? message.content.text : ''}
          </p>
        </div>
      </div>
    );
  }

  const events: Record<string, unknown>[] =
    streamingEvents ?? (message?.content.type === 'assistant' ? message.content.events : []);

  return (
    <div className="mb-4">
      <div className="max-w-[80%] rounded-lg bg-sidebar-bg px-4 py-2 text-sm text-foreground">
        {renderEvents(events, navigateToLogs)}
      </div>
    </div>
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
    deleteConversation,
    sendMessage,
    cancelMessage,
  } = useChatStore();

  const navigate = useNavigate();
  const runningDeployments = deployments.filter((d) => d.status === 'running');
  const [selectedDeploymentId, setSelectedDeploymentId] = useState(search.deploymentId || '');
  const [selectedAgentName, setSelectedAgentName] = useState(search.agentName || '');
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !selectedConversationId || isStreaming) return;
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    try {
      await sendMessage(selectedConversationId, text);
    } catch (err) {
      console.error('[Chat] Failed to send message:', err);
      // Note: store already clears sending flag on error
    }
  }, [input, selectedConversationId, isStreaming, sendMessage]);

  const selectedDeployment = deployments.find((d) => d.id === selectedDeploymentId);
  const agentNames = selectedDeployment?.config.agents
    ? Object.keys(selectedDeployment.config.agents)
    : [];
  const agentConfig = selectedDeployment?.config?.agents?.[selectedAgentName]
    ?? selectedDeployment?.config?.agent;
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
              <li
                key={conv.id}
                className={`group flex items-start justify-between transition-colors hover:bg-sidebar-hover ${
                  conv.id === selectedConversationId ? 'bg-sidebar-hover' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={() => selectConversation(conv.id)}
                  className={`min-w-0 flex-1 px-4 py-2 text-left text-xs ${
                    conv.id === selectedConversationId ? 'text-foreground' : 'text-muted'
                  }`}
                >
                  <p className="truncate font-medium">{conv.title}</p>
                  <p className="truncate text-muted/60">{conv.agentName}</p>
                </button>
                <button
                  type="button"
                  onClick={() => deleteConversation(conv.id)}
                  className="mr-2 mt-2 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label={`Delete conversation ${conv.title}`}
                >
                  <Trash2 size={10} />
                </button>
              </li>
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
            <span className="text-xs text-muted">
              {formatModelName(activeModel)}
            </span>
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

        <div className="border-t border-border px-6 py-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
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
              placeholder={
                selectedConversationId ? 'Type a message…' : 'Select a conversation first'
              }
              disabled={!selectedConversationId || isStreaming}
              className="flex-1 resize-none rounded-lg border border-border bg-sidebar-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none disabled:opacity-50"
            />
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
                disabled={!input.trim() || !selectedConversationId}
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

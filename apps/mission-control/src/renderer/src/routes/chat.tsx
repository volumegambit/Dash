import { createFileRoute } from '@tanstack/react-router';
import { Loader, Plus, Send, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { McAgentEvent } from '../../../shared/ipc.js';
import { useDeploymentsStore } from '../stores/deployments.js';
import { useChatStore } from '../stores/chat.js';
import type { McMessage } from '@dash/mc';

// --- Event rendering helpers ---

function renderEvents(events: Record<string, unknown>[]): JSX.Element[] {
  const elements: JSX.Element[] = [];
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
        elements.push(
          <ThinkingBlock key={`think-${i}`} text={thinkingBuffer} />,
        );
        thinkingBuffer = '';
      }
      textBuffer += event.text;
    } else if (event.type === 'tool_use_start') {
      // Flush text before tool
      if (textBuffer) {
        elements.push(<p key={`text-${i}`} className="whitespace-pre-wrap">{textBuffer}</p>);
        textBuffer = '';
      }
      toolName = event.name;
      toolInputBuffer = '';
    } else if (event.type === 'tool_use_delta') {
      toolInputBuffer += event.partial_json;
    } else if (event.type === 'tool_result') {
      elements.push(
        <ToolBlock key={`tool-${i}`} name={toolName || event.name} input={toolInputBuffer} result={event.content} isError={event.isError} />,
      );
      toolName = '';
      toolInputBuffer = '';
    } else if (event.type === 'error') {
      elements.push(
        <p key={`err-${i}`} className="text-red-400">{String(event.error)}</p>,
      );
    }
  }

  // Flush remaining
  if (thinkingBuffer) elements.push(<ThinkingBlock key="think-final" text={thinkingBuffer} />);
  if (textBuffer) elements.push(<p key="text-final" className="whitespace-pre-wrap">{textBuffer}</p>);
  // Flush in-progress tool call (tool_use_start seen but no tool_result yet)
  if (toolName) {
    elements.push(
      <div key="tool-progress" className="mb-2 text-xs text-muted">
        🔧 <span className="font-mono">{toolName}</span>({toolInputBuffer || '…'})
      </div>
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

function ToolBlock({ name, input, result, isError }: { name: string; input: string; result: string; isError?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={`mb-2 rounded border text-xs ${isError ? 'border-red-900/50 bg-red-900/10' : 'border-border bg-sidebar-hover'}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-1.5 text-left hover:text-foreground"
      >
        🔧 <span className="font-mono">{name}</span>
        {isError ? ' ✗' : ' ✓'}
      </button>
      {open && (
        <div className="border-t border-border px-3 pb-2 pt-1">
          {input && <p className="mb-1 font-mono text-muted">{input}</p>}
          <p className={`whitespace-pre-wrap ${isError ? 'text-red-400' : 'text-green-400/80'}`}>{result}</p>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message, streamingEvents }: { message?: McMessage; streamingEvents?: McAgentEvent[] }): JSX.Element {
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
    streamingEvents ??
    (message?.content.type === 'assistant' ? message.content.events : []);

  return (
    <div className="mb-4">
      <div className="max-w-[80%] rounded-lg bg-sidebar-bg px-4 py-2 text-sm text-foreground">
        {renderEvents(events)}
      </div>
    </div>
  );
}

// --- Main Chat component ---

function Chat(): JSX.Element {
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

  const runningDeployments = deployments.filter((d) => d.status === 'running');
  const [selectedDeploymentId, setSelectedDeploymentId] = useState('');
  const [selectedAgentName, setSelectedAgentName] = useState('');
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadDeployments();
  }, [loadDeployments]);

  // Auto-select first running deployment
  useEffect(() => {
    if (!selectedDeploymentId && runningDeployments.length > 0) {
      setSelectedDeploymentId(runningDeployments[0].id);
    }
  }, [selectedDeploymentId, runningDeployments]);

  // Load conversations and auto-select agent when deployment changes
  useEffect(() => {
    if (!selectedDeploymentId) return;
    loadConversations(selectedDeploymentId);

    const dep = deployments.find((d) => d.id === selectedDeploymentId);
    if (dep?.config.agents) {
      const agentNames = Object.keys(dep.config.agents);
      if (agentNames.length > 0 && !selectedAgentName) {
        setSelectedAgentName(agentNames[0]);
      }
    }
  }, [selectedDeploymentId, deployments, loadConversations, selectedAgentName]);

  // Scroll to bottom on new messages
  const selectedMessages = selectedConversationId ? (messages[selectedConversationId] ?? []) : [];
  const isStreaming = selectedConversationId ? (sending[selectedConversationId] ?? false) : false;
  const liveEvents = selectedConversationId ? (streamingEvents[selectedConversationId] ?? []) : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selectedMessages.length, liveEvents.length]);

  const handleNewConversation = useCallback(async () => {
    if (!selectedDeploymentId || !selectedAgentName) return;
    const conv = await createConversation(selectedDeploymentId, selectedAgentName);
    await selectConversation(conv.id);
  }, [selectedDeploymentId, selectedAgentName, createConversation, selectConversation]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !selectedConversationId || isStreaming) return;
    setInput('');
    await sendMessage(selectedConversationId, text);
  }, [input, selectedConversationId, isStreaming, sendMessage]);

  const selectedDeployment = deployments.find((d) => d.id === selectedDeploymentId);
  const agentNames = selectedDeployment?.config.agents
    ? Object.keys(selectedDeployment.config.agents)
    : [];

  return (
    <div className="flex h-full">
      {/* Left panel: conversation list */}
      <div className="flex w-64 flex-col border-r border-border">
        <div className="border-b border-border px-4 py-3">
          {/* Deployment picker */}
          {runningDeployments.length > 1 && (
            <select
              value={selectedDeploymentId}
              onChange={(e) => { setSelectedDeploymentId(e.target.value); setSelectedAgentName(''); }}
              className="mb-2 w-full rounded border border-border bg-sidebar-bg px-2 py-1 text-xs text-foreground focus:outline-none"
            >
              {runningDeployments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
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
                <option key={name} value={name}>{name}</option>
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

        <div className="flex-1 overflow-y-auto py-2">
          {conversations.length === 0 ? (
            <p className="px-4 text-xs text-muted">No conversations yet.</p>
          ) : (
            conversations.map((conv) => (
              <div
                key={conv.id}
                className={`group flex cursor-pointer items-start justify-between px-4 py-2 text-xs transition-colors hover:bg-sidebar-hover ${
                  conv.id === selectedConversationId ? 'bg-sidebar-hover text-foreground' : 'text-muted'
                }`}
                onClick={() => selectConversation(conv.id)}
                onKeyDown={(e) => e.key === 'Enter' && selectConversation(conv.id)}
                role="button"
                tabIndex={0}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{conv.title}</p>
                  <p className="truncate text-muted/60">{conv.agentName}</p>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                  className="ml-1 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right panel: message thread */}
      <div className="flex flex-1 flex-col">
        <div className="border-b border-border px-6 py-4">
          <h1 className="text-2xl font-bold">Chat</h1>
          <p className="mt-1 text-sm text-muted">
            {!selectedConversationId
              ? 'Select or create a conversation'
              : isStreaming
              ? 'Agent is responding…'
              : 'Connected'}
          </p>
        </div>

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
                <MessageBubble key={`${msg.role}-${i}`} message={msg} />
              ))}
              {isStreaming && liveEvents.length === 0 && (
                <div className="mb-4 flex items-center gap-2 text-sm text-muted">
                  <Loader size={14} className="animate-spin" />
                  Thinking…
                </div>
              )}
              {isStreaming && liveEvents.length > 0 && (
                <MessageBubble streamingEvents={liveEvents} />
              )}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="border-t border-border px-6 py-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); handleSend(); }}
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={selectedConversationId ? 'Type a message…' : 'Select a conversation first'}
              disabled={!selectedConversationId || isStreaming}
              className="flex-1 rounded-lg border border-border bg-sidebar-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none disabled:opacity-50"
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
  component: Chat,
  validateSearch: (search: Record<string, unknown>) => ({
    agent: (search.agent as string) ?? '',
  }),
});

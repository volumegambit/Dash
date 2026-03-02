import { createFileRoute } from '@tanstack/react-router';
import { Loader, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDeploymentsStore } from '../stores/deployments';

interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  text: string;
}

function scrollToRef(ref: React.RefObject<HTMLDivElement | null>): void {
  requestAnimationFrame(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth' });
  });
}

function Chat(): JSX.Element {
  const { deployments, loadDeployments } = useDeploymentsStore();
  const runningAgents = deployments.filter((d) => d.status === 'running');

  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Load deployments on mount
  useEffect(() => {
    loadDeployments();
  }, [loadDeployments]);

  // Read ?agent= search param
  const { agent: agentParam } = Route.useSearch();
  useEffect(() => {
    if (agentParam && !selectedAgentId) {
      setSelectedAgentId(agentParam);
    }
  }, [agentParam, selectedAgentId]);

  // Auto-select first running agent if none selected
  useEffect(() => {
    if (!selectedAgentId && runningAgents.length > 0) {
      setSelectedAgentId(runningAgents[0].id);
    }
  }, [selectedAgentId, runningAgents]);

  // Connect to selected agent
  useEffect(() => {
    if (!selectedAgentId) return;

    const deployment = deployments.find((d) => d.id === selectedAgentId);
    if (!deployment || deployment.status !== 'running' || !deployment.chatPort) return;

    const token = deployment.chatToken ?? '';
    const gatewayUrl = `ws://localhost:${deployment.chatPort}/ws?token=${token}`;

    setConnecting(true);
    setConnected(false);
    setMessages([]);

    // Clean up previous connection
    cleanupRef.current?.();

    window.api.chatConnect(gatewayUrl).then(() => {
      setConnected(true);
      setConnecting(false);
    });

    const cleanupResponse = window.api.chatOnResponse((_conversationId, text) => {
      setMessages((prev) => [...prev, { role: 'assistant', text }]);
      setSending(false);
      scrollToRef(messagesEndRef);
    });

    const cleanupError = window.api.chatOnError((_conversationId, error) => {
      setMessages((prev) => [...prev, { role: 'error', text: error }]);
      setSending(false);
      scrollToRef(messagesEndRef);
    });

    const cleanup = () => {
      cleanupResponse();
      cleanupError();
      window.api.chatDisconnect();
    };
    cleanupRef.current = cleanup;

    return cleanup;
  }, [selectedAgentId, deployments]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || sending) return;

    setMessages((prev) => [...prev, { role: 'user', text }]);
    setInput('');
    setSending(true);
    scrollToRef(messagesEndRef);
    window.api.chatSend(`mc-${selectedAgentId}`, text);
  }, [input, sending, selectedAgentId]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Chat</h1>
            <p className="mt-1 text-sm text-muted">
              {connecting
                ? 'Connecting...'
                : connected
                  ? 'Connected to agent'
                  : runningAgents.length === 0
                    ? 'No running agents'
                    : 'Select an agent to chat with'}
            </p>
          </div>
          {runningAgents.length > 0 && (
            <select
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              className="rounded-lg border border-border bg-sidebar-bg px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              {runningAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.id})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {runningAgents.length === 0 ? (
          <p className="text-center text-sm text-muted">
            Deploy an agent first, then come back here to chat.
          </p>
        ) : messages.length === 0 ? (
          <p className="text-center text-sm text-muted">Send a message to start a conversation.</p>
        ) : (
          messages.map((msg, i) => (
            <div
              key={`${msg.role}-${i}`}
              className={`mb-4 ${msg.role === 'user' ? 'text-right' : ''}`}
            >
              <div
                className={`inline-block max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                  msg.role === 'user'
                    ? 'bg-primary text-white'
                    : msg.role === 'error'
                      ? 'bg-red-900/30 text-red-400'
                      : 'bg-sidebar-bg text-foreground'
                }`}
              >
                <p className="whitespace-pre-wrap">{msg.text}</p>
              </div>
            </div>
          ))
        )}
        {sending && (
          <div className="mb-4 flex items-center gap-2 text-sm text-muted">
            <Loader size={14} className="animate-spin" />
            Thinking...
          </div>
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
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 rounded-lg border border-border bg-sidebar-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
            disabled={sending || !connected}
          />
          <button
            type="submit"
            disabled={sending || !input.trim() || !connected}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            <Send size={16} />
          </button>
        </form>
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

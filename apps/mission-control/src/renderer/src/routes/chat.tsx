import { createFileRoute } from '@tanstack/react-router';
import { Loader, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  text: string;
}

const GATEWAY_URL = 'ws://localhost:9200';
const CONVERSATION_ID = 'mc-default';

function scrollToRef(ref: React.RefObject<HTMLDivElement | null>): void {
  requestAnimationFrame(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth' });
  });
}

function Chat(): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.api.chatConnect(GATEWAY_URL).then(() => setConnected(true));

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

    return () => {
      cleanupResponse();
      cleanupError();
      window.api.chatDisconnect();
    };
  }, []);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || sending) return;

    setMessages((prev) => [...prev, { role: 'user', text }]);
    setInput('');
    setSending(true);
    scrollToRef(messagesEndRef);
    window.api.chatSend(CONVERSATION_ID, text);
  }, [input, sending]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-2xl font-bold">Chat</h1>
        <p className="mt-1 text-sm text-muted">
          {connected ? 'Connected to gateway' : 'Connecting...'}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && (
          <p className="text-center text-sm text-muted">Send a message to start a conversation.</p>
        )}
        {messages.map((msg, i) => (
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
        ))}
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
            disabled={sending}
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
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
});

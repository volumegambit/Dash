import { type FormEvent, useEffect, useState } from 'react';
import { useWebAppStore } from './Shell.js';
import { ContentBlocks } from './blocks/ContentBlocks.js';

export interface ChatViewProps {
  conversationId: string | null;
  /** The gateway's human-facing name — `GatewayInfo` has no `label`, so
   * callers pass its `subdomain` (see `Shell`). Used only for the
   * gateway-unreachable copy. */
  gatewayLabel: string;
}

/** Exact banner text shown while the store is retrying a dropped socket. */
export const RECONNECTING_COPY = 'Reconnecting…';

function unreachableCopy(gatewayLabel: string): string {
  return `Your gateway '${gatewayLabel}' is unreachable.`;
}

/**
 * The main chat surface: renders the open conversation's transcript
 * (confirmed `messages` plus, mid-turn, the `streaming` assistant content —
 * both from the Task 11 store's `Transcript`, via `useWebAppStore()`) and a
 * send box. Calls `openConversation()` whenever `conversationId` changes;
 * when the store's `connection` is `'offline'` (the gateway is unreachable
 * even after the store's own retry budget — see `RECONNECT_MAX_ATTEMPTS` in
 * `state/store.ts`) this renders only the unreachable message, since neither
 * history nor a live socket exist to show anything else against.
 */
export function ChatView({ conversationId, gatewayLabel }: ChatViewProps) {
  const useAppStore = useWebAppStore();
  const connection = useAppStore((s) => s.connection);
  const transcript = useAppStore((s) =>
    conversationId ? s.transcripts[conversationId] : undefined,
  );
  const openConversation = useAppStore((s) => s.openConversation);
  const sendMessage = useAppStore((s) => s.sendMessage);

  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    void openConversation(conversationId);
  }, [conversationId, openConversation]);

  // 'unauthorized' is Shell's cue to clear the dead credential and route
  // back to 'pick-gateway' (see Shell's store-subscription effect) — by the
  // time that happens this component unmounts anyway, but guard explicitly
  // rather than falling through to the 'offline'/'reconnecting' banners
  // below, which would misdescribe a revoked credential as a transport
  // problem. Exhaustive over the `connection` union on purpose: every value
  // gets its own branch rather than relying on the negative space of the
  // other checks.
  if (connection === 'unauthorized') {
    return null;
  }

  if (connection === 'offline') {
    return (
      <div>
        <p role="alert">{unreachableCopy(gatewayLabel)}</p>
      </div>
    );
  }

  if (!conversationId) {
    return (
      <div>
        <p>Select a conversation to get started.</p>
      </div>
    );
  }

  const messages = transcript?.messages ?? [];
  const streaming = transcript?.streaming ?? null;
  const canSend = connection === 'connected';

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !conversationId || !canSend) return;
    setSendError(null);
    try {
      await sendMessage(conversationId, text);
      setDraft('');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message.');
    }
  }

  return (
    <div>
      {connection === 'reconnecting' && <output>{RECONNECTING_COPY}</output>}
      {transcript?.error && <p role="alert">{transcript.error.message}</p>}

      <div>
        {messages.map((message) => (
          <div key={message.id} data-testid="chat-message" data-role={message.role}>
            <ContentBlocks content={message.content} />
            {message.status === 'failed' && (
              <span role="alert" style={{ color: '#b00020', fontSize: '0.85em' }}>
                Failed to send
              </span>
            )}
          </div>
        ))}
        {streaming && (
          <div data-testid="chat-message-streaming" data-role="assistant">
            <ContentBlocks content={streaming} />
          </div>
        )}
      </div>

      <form onSubmit={(event) => void handleSubmit(event)}>
        <input
          aria-label="Message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={!canSend}
          placeholder={canSend ? 'Message…' : 'Reconnecting…'}
        />
        <button type="submit" disabled={!canSend || !draft.trim()}>
          Send
        </button>
      </form>
      {sendError && <p role="alert">{sendError}</p>}
    </div>
  );
}

export default ChatView;

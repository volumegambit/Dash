import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../../stores/chat.js';
import { MessageBubble } from '../../chat.js';

/**
 * Embedded live view of an agent session on the task detail page. Reuses the
 * Chat route's MessageBubble renderer and the global chat store — streaming
 * events arrive via the app-level IPC listeners regardless of route, so this
 * panel updates live without any extra wiring. The composer sends through the
 * same store action Chat uses; answering an agent's question here is the
 * whole point (sub-status waiting_on_human).
 */
export function SessionPanel({ conversationId }: { conversationId: string }): JSX.Element {
  const messages = useChatStore((s) => s.messages[conversationId]);
  const streamingEvents = useChatStore((s) => s.streamingEvents[conversationId]);
  const sending = useChatStore((s) => s.sending[conversationId] ?? false);
  const ensureMessages = useChatStore((s) => s.ensureMessages);
  const sendMessage = useChatStore((s) => s.sendMessage);

  const [draft, setDraft] = useState('');
  const [answeredQuestions, setAnsweredQuestions] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void ensureMessages(conversationId);
  }, [ensureMessages, conversationId]);

  // Follow the conversation as messages/stream chunks arrive.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on content growth
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages?.length, streamingEvents?.length]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');
    try {
      await sendMessage(conversationId, text);
    } catch {
      // Optimistic message stays visible; store handles the sending flag.
    }
  };

  const answerQuestion = (questionId: string, answer: string) => {
    setAnsweredQuestions((prev) => ({ ...prev, [questionId]: answer }));
    window.api.chatAnswerQuestion(conversationId, questionId, answer);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {!messages ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 size={12} className="animate-spin" /> Loading session…
          </div>
        ) : (
          <>
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                onAnswerQuestion={answerQuestion}
                answeredQuestions={answeredQuestions}
              />
            ))}
            {streamingEvents && streamingEvents.length > 0 && (
              <MessageBubble
                streamingEvents={streamingEvents}
                onAnswerQuestion={answerQuestion}
                answeredQuestions={answeredQuestions}
              />
            )}
            <div ref={bottomRef} />
          </>
        )}
      </div>
      <div className="shrink-0 border-t border-border p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Reply to the agent…"
          rows={2}
          disabled={sending}
          className="w-full border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50"
        />
      </div>
    </div>
  );
}

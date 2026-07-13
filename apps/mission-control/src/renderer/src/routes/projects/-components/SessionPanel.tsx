import type { ConversationRef } from '@dash/mc';
import type { MobileWsServerFrame } from '@dash/mobile-contract';
import { Loader2, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { McAgentEvent } from '../../../../../shared/ipc.js';
import { conversationKey, useChatStore } from '../../../stores/chat.js';
import { MessageBubble } from '../../chat.js';

const EMPTY_FRAMES: MobileWsServerFrame[] = [];

function eventsFromFrames(frames: MobileWsServerFrame[]): McAgentEvent[] {
  return frames.flatMap((frame) => {
    if (frame.type === 'event') return [frame.event as McAgentEvent];
    if (frame.type === 'error') {
      return [{ type: 'error', error: frame.error, timestamp: new Date().toISOString() }];
    }
    return [];
  });
}

export function SessionPanel({
  conversationRef,
}: {
  conversationRef: ConversationRef;
}): JSX.Element {
  const key = conversationKey(conversationRef);
  const conversation = useChatStore((state) =>
    state.conversations.find(
      (item) => item.id === conversationRef.id && item.origin === conversationRef.origin,
    ),
  );
  const messages = useChatStore((state) => state.messages[key]);
  const streamingFrames = useChatStore((state) => state.streamingFrames[key] ?? EMPTY_FRAMES);
  const sending = useChatStore((state) => state.sending[key] ?? false);
  const localTurnId = useChatStore((state) => state.localTurnIds[key]);
  const gatewayOnline = useChatStore((state) => state.gatewayOnline);
  const ensureMessages = useChatStore((state) => state.ensureMessages);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const cancelMessage = useChatStore((state) => state.cancelMessage);
  const answerQuestion = useChatStore((state) => state.answerQuestion);

  const [draft, setDraft] = useState('');
  const [answeredQuestions, setAnsweredQuestions] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamingEvents = useMemo(() => eventsFromFrames(streamingFrames), [streamingFrames]);

  const offline = Boolean(conversation?.offline || !gatewayOnline);
  const readOnly = Boolean(
    !conversation ||
      conversation.readOnly ||
      conversation.status === 'archived' ||
      conversation.status === 'deleted',
  );
  const remoteActive = Boolean(
    conversation?.activeTurnId && conversation.activeTurnId !== localTurnId,
  );
  const composerLocked = Boolean(
    offline ||
      readOnly ||
      remoteActive ||
      sending ||
      conversation?.status === 'running' ||
      conversation?.activeTurnId,
  );
  const questionLocked = offline || readOnly;
  const placeholder = offline
    ? 'Reconnect to send a message'
    : readOnly
      ? 'This conversation is read-only'
      : remoteActive
        ? 'Conversation active on another device'
        : 'Reply to the agent…';

  useEffect(() => {
    void ensureMessages(conversationRef).catch(() => {});
  }, [ensureMessages, conversationRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only when transcript content grows
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages?.length, streamingEvents.length]);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || composerLocked) return;
    setDraft('');
    try {
      await sendMessage(conversationRef, text);
    } catch {
      // The store owns the optimistic record and error reconciliation.
    }
  };

  const handleAnswerQuestion = (questionId: string, answer: string): void => {
    if (questionLocked) return;
    answerQuestion(conversationRef, questionId, answer);
    setAnsweredQuestions((current) => ({ ...current, [questionId]: answer }));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {offline && (
        <div className="border-b border-border bg-yellow-900/20 px-5 py-2 text-xs text-yellow-200">
          Gateway offline — cached conversations are read-only.
        </div>
      )}
      {remoteActive && (
        <div className="border-b border-border bg-sidebar-hover px-5 py-2 text-xs text-muted">
          Active on another device
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {!messages ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 size={12} className="animate-spin" /> Loading session…
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onAnswerQuestion={questionLocked ? undefined : handleAnswerQuestion}
                answeredQuestions={answeredQuestions}
              />
            ))}
            {streamingEvents.length > 0 && (
              <MessageBubble
                streamingEvents={streamingEvents}
                onAnswerQuestion={questionLocked ? undefined : handleAnswerQuestion}
                answeredQuestions={answeredQuestions}
              />
            )}
            <div ref={bottomRef} />
          </>
        )}
      </div>
      <div className="shrink-0 border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={placeholder}
            rows={2}
            disabled={composerLocked}
            className="w-full border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50"
          />
          {conversation?.activeTurnId && (
            <button
              type="button"
              onClick={() => cancelMessage(conversationRef)}
              aria-label="Stop active turn"
              className="bg-red-900/50 p-2.5 text-red transition-colors hover:bg-red-900/70"
            >
              <Square size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

import type { ConversationRef } from '@dash/mc';
import type { MobileWsServerFrame } from '@dash/mobile-contract';
import { Loader2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { McAgentEvent } from '../../../../../shared/ipc.js';
import { ChatComposer, type ChatComposerAttempt } from '../../../components/chat/ChatComposer.js';
import { FollowUpQueue } from '../../../components/chat/FollowUpQueue.js';
import {
  type ConversationKey,
  conversationKey,
  conversationRefFromKey,
  conversationSourceFor,
  useChatStore,
} from '../../../stores/chat.js';
import { MessageBubble, V2ConversationTimeline } from '../../chat.js';

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
  const reactId = useId();
  const ownerId = useMemo(() => `session-panel:${reactId}`, [reactId]);
  const stableRef = useMemo<ConversationRef>(
    () => ({ id: conversationRef.id, origin: conversationRef.origin }),
    [conversationRef.id, conversationRef.origin],
  );
  const key = conversationKey(stableRef);
  const chatState = useChatStore();
  const {
    conversations,
    gatewayOnline,
    messages,
    streamingFrames,
    localTurnIds,
    sending,
    protocolByConversation,
    v2Projections,
    commandIssuesByConversation,
    answerAttemptsByConversation,
    openConversation,
    closeConversation,
    sendMessage,
    enqueueInput,
    editFollowUp,
    removeFollowUp,
    resumeFollowUps,
    cancelMessage,
    answerQuestion,
    clearCommandIssue,
  } = chatState;
  const conversation = conversations.find(
    (item) => item.id === stableRef.id && item.origin === stableRef.origin,
  );
  const source = conversationSourceFor(chatState, stableRef);
  const runtimeConversation = source?.summary ?? null;
  const projection = v2Projections[key];
  const protocol = protocolByConversation[key] ?? 'v1';
  const queueCapable = stableRef.origin === 'gateway' && protocol === 'v2';
  const legacyMessages = messages[key];
  const legacyFrames = streamingFrames[key] ?? EMPTY_FRAMES;
  const legacyEvents = useMemo(() => eventsFromFrames(legacyFrames), [legacyFrames]);
  const [answeredQuestions, setAnsweredQuestions] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const offline = Boolean(conversation?.offline || !gatewayOnline);
  const readOnly = Boolean(
    !conversation ||
      !runtimeConversation ||
      conversation.readOnly ||
      runtimeConversation.status === 'archived' ||
      runtimeConversation.status === 'deleted',
  );
  const editable = Boolean(conversation && runtimeConversation && !offline && !readOnly);
  const remoteActive = Boolean(
    runtimeConversation?.activeTurnId && runtimeConversation.activeTurnId !== localTurnIds[key],
  );
  const questionLocked = offline || readOnly;
  const placeholder = offline
    ? 'Reconnect to send a message'
    : readOnly
      ? 'This conversation is read-only'
      : remoteActive && !queueCapable
        ? 'Conversation active on another device'
        : 'Reply to the agent…';
  const queueItems = projection
    ? projection.queueOrder.flatMap((inputId) => {
        const item = projection.inputs[inputId];
        return item ? [item] : [];
      })
    : [];

  useEffect(() => {
    void openConversation(stableRef, ownerId).catch(() => {});
    return () => {
      void closeConversation(stableRef, ownerId).catch(() => {});
    };
  }, [closeConversation, openConversation, ownerId, stableRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only when transcript content grows
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [
    legacyMessages?.length,
    legacyEvents.length,
    projection?.timeline.length,
    projection?.lastAppliedV2Seq,
  ]);

  const handleAnswerQuestion = (questionId: string, answer: string): void => {
    if (questionLocked) return;
    answerQuestion(stableRef, questionId, answer);
    if (source?.protocol !== 'v2') {
      setAnsweredQuestions((current) => ({ ...current, [questionId]: answer }));
    }
  };

  const handleSend = (attempt: ChatComposerAttempt): Promise<void> => {
    const ref = conversationRefFromKey(attempt.conversationKey as ConversationKey);
    return sendMessage(ref, attempt.payload.text, attempt.payload.images, attempt.draftRevision);
  };

  const handleEnqueue = async (
    behavior: 'steer' | 'followUp',
    attempt: ChatComposerAttempt,
  ): Promise<void> => {
    const ref = conversationRefFromKey(attempt.conversationKey as ConversationKey);
    await enqueueInput(ref, {
      behavior,
      text: attempt.payload.text,
      ...(attempt.payload.images ? { images: attempt.payload.images } : {}),
    });
  };

  const transcriptLoaded =
    source?.protocol === 'v2' ? Boolean(projection) : Boolean(legacyMessages);

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
        {!transcriptLoaded ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 size={12} className="animate-spin" /> Loading session…
          </div>
        ) : source?.protocol === 'v2' && projection ? (
          <V2ConversationTimeline
            projection={projection}
            onAnswerQuestion={questionLocked ? undefined : handleAnswerQuestion}
            answerAttempts={answerAttemptsByConversation[key]}
          />
        ) : (
          <>
            {legacyMessages?.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onAnswerQuestion={questionLocked ? undefined : handleAnswerQuestion}
                answeredQuestions={answeredQuestions}
              />
            ))}
            {Boolean(sending[key]) && legacyEvents.length === 0 && (
              <div className="mb-4 flex items-center gap-2 py-2 text-xs text-muted">
                <Loader2 size={12} className="animate-spin" /> Thinking…
              </div>
            )}
            {legacyEvents.length > 0 && (
              <MessageBubble
                streamingEvents={legacyEvents}
                onAnswerQuestion={questionLocked ? undefined : handleAnswerQuestion}
                answeredQuestions={answeredQuestions}
              />
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {source?.protocol === 'v2' && projection && (
        <FollowUpQueue
          conversationKey={key}
          items={queueItems}
          paused={projection.queuePaused}
          composerRef={composerRef}
          onEdit={(inputId, revision, payload) =>
            editFollowUp(stableRef, inputId, revision, payload.text, payload.images).then(
              () => undefined,
            )
          }
          onRemove={(inputId, revision) => removeFollowUp(stableRef, inputId, revision)}
          onResume={() => resumeFollowUps(stableRef)}
        />
      )}

      <ChatComposer
        conversationKey={key}
        composerRef={composerRef}
        activeTurnId={runtimeConversation?.activeTurnId ?? null}
        queueCapable={queueCapable}
        editable={editable}
        queuePaused={projection?.queuePaused ?? false}
        placeholder={placeholder}
        commandError={commandIssuesByConversation[key]?.apiError.error}
        onDismissCommandError={() => clearCommandIssue(stableRef)}
        onSend={handleSend}
        onEnqueue={handleEnqueue}
        onStop={() => cancelMessage(stableRef)}
      />
    </div>
  );
}

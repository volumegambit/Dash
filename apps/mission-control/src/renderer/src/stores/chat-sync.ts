import type { ConversationMessage, MobileWsServerFrame } from '@dash/mobile-contract';

export function mergeCanonicalMessages(
  current: ConversationMessage[],
  incoming: ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    for (const [id, existing] of byId) {
      if (
        id.startsWith('optimistic:') &&
        existing.turnId === message.turnId &&
        existing.role === message.role
      ) {
        byId.delete(id);
      }
    }
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.ordinal - b.ordinal);
}

export function replaceAcceptedOptimisticMessage(
  messages: ConversationMessage[],
  accepted: Extract<MobileWsServerFrame, { type: 'accepted' }>,
): ConversationMessage[] {
  return messages.map((message) =>
    message.turnId === accepted.id && message.role === 'user'
      ? { ...message, id: accepted.userMessageId }
      : message,
  );
}

export interface SequencedFrames {
  lastSeq: number;
  frames: MobileWsServerFrame[];
}

export function applySequencedFrame(
  state: SequencedFrames,
  frame: MobileWsServerFrame,
): { state: SequencedFrames; gapAfter: number | null } {
  const seq = 'seq' in frame && typeof frame.seq === 'number' ? frame.seq : null;
  if (seq === null || seq <= state.lastSeq) return { state, gapAfter: null };
  if (seq !== state.lastSeq + 1) return { state, gapAfter: state.lastSeq };
  return {
    state: { lastSeq: seq, frames: [...state.frames, frame] },
    gapAfter: null,
  };
}

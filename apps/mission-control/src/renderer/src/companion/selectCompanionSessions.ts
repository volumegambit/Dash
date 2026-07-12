import type { ConversationMessage, MobileWsServerFrame } from '@dash/mobile-contract';
import type { McAgentEvent } from '../../../shared/ipc.js';
import { summarize, toolLabel } from '../routes/chat.helpers.js';
import { conversationKey } from '../stores/chat.js';
import type { CompanionSession, CompanionSnapshot, CompanionStatus } from './types.js';

const RANK: Record<CompanionStatus, number> = { error: 0, needs: 1, working: 2, done: 3 };

function eventsOf(message: ConversationMessage | undefined): McAgentEvent[] {
  if (message?.content.type === 'assistant') {
    return message.content.events as McAgentEvent[];
  }
  return [];
}

function frameEvents(frames: MobileWsServerFrame[]): McAgentEvent[] {
  return frames.flatMap((frame) => {
    if (frame.type === 'event') return [frame.event as McAgentEvent];
    if (frame.type === 'error') return [{ type: 'error', error: frame.error, timestamp: '' }];
    return [];
  });
}

function latestEvents(snapshot: CompanionSnapshot, key: CompanionSession['conversationKey']) {
  const live = frameEvents(snapshot.streamingFrames[key] ?? []);
  if (live.length > 0) return live;
  const messages = snapshot.messages[key] ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant') return eventsOf(messages[index]);
  }
  return [];
}

function concatText(events: McAgentEvent[]): string {
  let output = '';
  for (const event of events) if (event.type === 'text_delta') output += event.text;
  return output.trim();
}

function truncate(value: string, max = 120): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function workingPreview(events: McAgentEvent[]): string {
  const open = new Map<string, { name: string; input?: Record<string, unknown> }>();
  for (const event of events) {
    if (event.type === 'tool_use_start') {
      open.set(event.id, { name: event.name, input: event.input });
    } else if (event.type === 'tool_result') {
      open.delete(event.id);
    }
  }
  let last: { name: string; input?: Record<string, unknown> } | undefined;
  for (const value of open.values()) last = value;
  if (last) {
    const detail = summarize(last.name, JSON.stringify(last.input ?? {}));
    return detail ? `${toolLabel(last.name)}: ${detail}` : toolLabel(last.name);
  }
  const text = concatText(events);
  return text ? truncate(text) : 'Working…';
}

export function selectCompanionSessions(snapshot: CompanionSnapshot): CompanionSession[] {
  const sessions: CompanionSession[] = [];
  for (const conversation of snapshot.conversations) {
    const ref = { id: conversation.id, origin: conversation.origin } as const;
    const key = conversationKey(ref);
    const events = latestEvents(snapshot, key);
    const last = events.at(-1);

    let status: CompanionStatus | null = null;
    let preview = '';
    if (last?.type === 'error') {
      status = 'error';
      preview = truncate(last.error);
    } else if (last?.type === 'question') {
      status = 'needs';
      preview = truncate(last.question);
    } else if (snapshot.sending[key]) {
      status = 'working';
      preview = workingPreview(events);
    } else if (snapshot.unreadConversations.has(key)) {
      status = 'done';
      preview = truncate(concatText(events)) || 'Finished';
    }
    if (!status) continue;

    sessions.push({
      conversation: ref,
      conversationKey: key,
      agentId: conversation.agentId,
      agentName: conversation.agentName || snapshot.agentName(conversation.agentId),
      title: conversation.title,
      status,
      preview,
      since: Date.parse(conversation.updatedAt) || 0,
    });
  }
  sessions.sort(
    (left, right) => RANK[left.status] - RANK[right.status] || right.since - left.since,
  );
  return sessions;
}

import type { McMessage } from '@dash/mc';
import type { McAgentEvent } from '../../../shared/ipc.js';
import { summarize, toolLabel } from '../routes/chat.helpers.js';
import type { CompanionSession, CompanionSnapshot, CompanionStatus } from './types.js';

const RANK: Record<CompanionStatus, number> = { error: 0, needs: 1, working: 2, done: 3 };

function eventsOf(msg: McMessage | undefined): McAgentEvent[] {
  if (msg && msg.content.type === 'assistant')
    return msg.content.events as unknown as McAgentEvent[];
  return [];
}

function latestEvents(s: CompanionSnapshot, id: string): McAgentEvent[] {
  const live = s.streamingEvents[id];
  if (live && live.length > 0) return live;
  const msgs = s.messages[id] ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') return eventsOf(msgs[i]);
  }
  return [];
}

function concatText(ev: McAgentEvent[]): string {
  let out = '';
  for (const e of ev) if (e.type === 'text_delta') out += e.text;
  return out.trim();
}

function truncate(value: string, max = 120): string {
  const t = value.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function workingPreview(ev: McAgentEvent[]): string {
  const open = new Map<string, { name: string; input?: Record<string, unknown> }>();
  for (const e of ev) {
    if (e.type === 'tool_use_start') open.set(e.id, { name: e.name, input: e.input });
    else if (e.type === 'tool_result') open.delete(e.id);
  }
  if (open.size > 0) {
    const last = [...open.values()][open.size - 1];
    const detail = summarize(last.name, JSON.stringify(last.input ?? {}));
    return detail ? `${toolLabel(last.name)}: ${detail}` : toolLabel(last.name);
  }
  const text = concatText(ev);
  return text ? truncate(text) : 'Working…';
}

export function selectCompanionSessions(s: CompanionSnapshot): CompanionSession[] {
  const out: CompanionSession[] = [];
  for (const conv of s.conversations) {
    const id = conv.id;
    const ev = latestEvents(s, id);
    const last = ev.length > 0 ? ev[ev.length - 1] : undefined;

    let status: CompanionStatus | null = null;
    let preview = '';
    if (last && last.type === 'error') {
      status = 'error';
      preview = truncate(last.error);
    } else if (last && last.type === 'question') {
      status = 'needs';
      preview = truncate(last.question);
    } else if (s.sending[id]) {
      status = 'working';
      preview = workingPreview(ev);
    } else if (s.unreadConversations.has(id)) {
      status = 'done';
      preview = truncate(concatText(ev)) || 'Finished';
    }
    if (!status) continue;

    out.push({
      conversationId: id,
      agentId: conv.agentId,
      agentName: s.agentName(conv.agentId),
      title: conv.title,
      status,
      preview,
      since: Date.parse(conv.updatedAt) || 0,
    });
  }
  out.sort((a, b) => RANK[a.status] - RANK[b.status] || b.since - a.since);
  return out;
}

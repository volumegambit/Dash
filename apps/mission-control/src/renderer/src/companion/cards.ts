import type { CompanionSession, CompanionStatus } from './types.js';

export type CardIcon = 'spinner' | 'check' | 'bang' | 'cross';

const ICON: Record<CompanionStatus, CardIcon> = {
  working: 'spinner',
  needs: 'bang',
  done: 'check',
  error: 'cross',
};

export function statusIcon(status: CompanionStatus): CardIcon {
  return ICON[status];
}

export function timeAgo(since: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  if (secs < 45) return 'now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function visibleCards(
  sessions: CompanionSession[],
  max = 4,
): { shown: CompanionSession[]; overflow: number } {
  return { shown: sessions.slice(0, max), overflow: Math.max(0, sessions.length - max) };
}

const ATTENTION: ReadonlySet<CompanionStatus> = new Set<CompanionStatus>([
  'needs',
  'error',
  'done',
]);

export function attentionIds(sessions: CompanionSession[]): Set<string> {
  const ids = new Set<string>();
  for (const s of sessions) if (ATTENTION.has(s.status)) ids.add(s.conversationId);
  return ids;
}

export function newAttentionIds(prev: Set<string>, sessions: CompanionSession[]): string[] {
  const fresh: string[] = [];
  for (const s of sessions) {
    if (ATTENTION.has(s.status) && !prev.has(s.conversationId)) fresh.push(s.conversationId);
  }
  return fresh;
}

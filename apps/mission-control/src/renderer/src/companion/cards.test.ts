import { describe, expect, it } from 'vitest';
import { attentionIds, newAttentionIds, statusIcon, timeAgo, visibleCards } from './cards.js';
import type { CompanionSession } from './types.js';

function sess(id: string, status: CompanionSession['status']): CompanionSession {
  return {
    conversationId: id,
    agentId: 'a',
    agentName: 'A',
    title: id,
    status,
    preview: '',
    since: 0,
  };
}

describe('statusIcon', () => {
  it('maps statuses to icon kinds', () => {
    expect(statusIcon('working')).toBe('spinner');
    expect(statusIcon('needs')).toBe('bang');
    expect(statusIcon('done')).toBe('check');
    expect(statusIcon('error')).toBe('cross');
  });
});

describe('timeAgo', () => {
  it('formats seconds, minutes, and hours', () => {
    const now = 3_600_000;
    expect(timeAgo(now, now)).toBe('now');
    expect(timeAgo(now - 90_000, now)).toBe('1m');
    expect(timeAgo(now - 3_600_000, now)).toBe('1h');
  });
});

describe('visibleCards', () => {
  it('splits into shown and overflow', () => {
    const list = [
      sess('1', 'needs'),
      sess('2', 'working'),
      sess('3', 'done'),
      sess('4', 'done'),
      sess('5', 'done'),
    ];
    const { shown, overflow } = visibleCards(list, 4);
    expect(shown).toHaveLength(4);
    expect(overflow).toBe(1);
  });

  it('reports zero overflow when within limit', () => {
    expect(visibleCards([sess('1', 'done')], 4).overflow).toBe(0);
  });
});

describe('attention diffing', () => {
  it('collects needs/error/done ids only', () => {
    const ids = attentionIds([sess('1', 'working'), sess('2', 'needs'), sess('3', 'done')]);
    expect([...ids].sort()).toEqual(['2', '3']);
  });

  it('returns ids that newly entered an attention state', () => {
    const prev = new Set(['2']);
    const fresh = newAttentionIds(prev, [sess('2', 'needs'), sess('3', 'done')]);
    expect(fresh).toEqual(['3']);
  });
});

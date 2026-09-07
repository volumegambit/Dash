import { describe, expect, it } from 'vitest';
import { selectRelevant, tokenize } from './recall.js';
import type { MemoryInfo } from './types.js';

function info(name: string, description: string, updatedAt = '2026-09-05'): MemoryInfo {
  return {
    name,
    description,
    type: 'project',
    source: 'agent',
    createdAt: '2026-09-01',
    updatedAt,
    size: 1,
  };
}

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, drops short tokens and stop words', () => {
    expect([...tokenize('The Deploy-Script for staging, please!')].sort()).toEqual(
      ['deploy', 'script', 'staging'].sort(),
    );
  });
});

describe('selectRelevant', () => {
  const memories = [
    info('deploy-staging', 'How to deploy the web app to staging with wrangler'),
    info('user-timezone', 'Gerry is in Singapore, UTC+8'),
    info('ios-simulator', 'Use the iOS 26.5 iPhone simulator for DashUI tests', '2026-09-04'),
    info('ios-signing', 'iOS signing config lives in Local.xcconfig', '2026-09-05'),
  ];

  it('returns only memories sharing tokens with the message, best first', () => {
    const out = selectRelevant(memories, 'how do I deploy to staging?');
    expect(out.map((m) => m.name)).toEqual(['deploy-staging']);
  });

  it('breaks ties by updatedAt descending and honours the limit', () => {
    const out = selectRelevant(memories, 'anything about ios?', { limit: 1 });
    expect(out.map((m) => m.name)).toEqual(['ios-signing']);
    expect(selectRelevant(memories, 'anything about ios?').map((m) => m.name)).toEqual([
      'ios-signing',
      'ios-simulator',
    ]);
  });

  it('returns nothing for an unrelated message', () => {
    expect(selectRelevant(memories, 'tell me a joke')).toEqual([]);
  });

  it('matches on the name as well as the description', () => {
    expect(selectRelevant(memories, 'what timezone?').map((m) => m.name)).toEqual([
      'user-timezone',
    ]);
  });
});

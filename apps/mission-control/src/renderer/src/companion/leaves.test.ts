import { describe, expect, it } from 'vitest';
import { MAX_LEAVES, assignLeaves, leafColors } from './leaves.js';

describe('leafColors', () => {
  it('maps each status to a distinct fill', () => {
    expect(leafColors('done').fill).toBe('#34c759');
    expect(leafColors('needs').fill).toBe('#f5c518');
    expect(leafColors('working').fill).toBe('#3da5d9');
    expect(leafColors('error').fill).toBe('#f87171');
  });
});

describe('assignLeaves', () => {
  it('fills every slot with a resting leaf when there are no sessions', () => {
    const leaves = assignLeaves([]);
    expect(leaves).toHaveLength(MAX_LEAVES);
    expect(leaves.every((l) => l.pulse === false)).toBe(true);
    expect(leaves[0].colors.fill).not.toBe('#34c759');
  });

  it('colors leading slots by status and pulses working', () => {
    const leaves = assignLeaves(['working', 'done']);
    expect(leaves[0].colors.fill).toBe('#3da5d9');
    expect(leaves[0].pulse).toBe(true);
    expect(leaves[1].colors.fill).toBe('#34c759');
    expect(leaves[1].pulse).toBe(false);
  });

  it('ignores statuses beyond the slot count', () => {
    const leaves = assignLeaves(['done', 'done', 'done', 'done', 'done', 'done', 'done']);
    expect(leaves).toHaveLength(MAX_LEAVES);
  });
});

import type { CompanionStatus } from './types.js';

export interface LeafColors {
  fill: string;
  hi: string;
  lo: string;
}

export interface AssignedLeaf {
  colors: LeafColors;
  pulse: boolean;
}

export const MAX_LEAVES = 5;

const STATUS_LEAF: Record<CompanionStatus, LeafColors> = {
  done: { fill: '#34c759', hi: '#6fe08a', lo: '#1f8f43' },
  needs: { fill: '#f5c518', hi: '#ffe06a', lo: '#bd9300' },
  working: { fill: '#3da5d9', hi: '#7fcdf0', lo: '#2173a0' },
  error: { fill: '#f87171', hi: '#f9a8a8', lo: '#b91c1c' },
};

const REST_LEAF: LeafColors = { fill: '#2f3a30', hi: '#3a463b', lo: '#222a24' };

export function leafColors(status: CompanionStatus): LeafColors {
  return STATUS_LEAF[status];
}

export function assignLeaves(statuses: CompanionStatus[], maxLeaves = MAX_LEAVES): AssignedLeaf[] {
  const out: AssignedLeaf[] = [];
  for (let i = 0; i < maxLeaves; i++) {
    const status = statuses[i];
    out.push(
      status
        ? { colors: leafColors(status), pulse: status === 'working' }
        : { colors: REST_LEAF, pulse: false },
    );
  }
  return out;
}

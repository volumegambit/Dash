import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentMemoryDir } from './paths.js';

describe('agentMemoryDir', () => {
  it('is <dataDir>/memory/<agentId>', () => {
    expect(agentMemoryDir('/data', 'abc-123')).toBe(resolve('/data', 'memory', 'abc-123'));
  });
});

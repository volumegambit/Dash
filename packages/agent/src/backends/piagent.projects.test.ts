import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { PiAgentBackend } from './piagent.js';

// A fake extra tool that records the session id observed at execute time.
function makeProbeTool(observed: { sessionId: string | null }, getSessionId: () => string | null) {
  return {
    name: 'probe_session',
    label: 'Probe',
    description: 'test probe',
    parameters: Type.Object({}),
    execute: async () => {
      observed.sessionId = getSessionId();
      return { content: [{ type: 'text' as const, text: 'ok' }], details: {} };
    },
  };
}

describe('PiAgentBackend extra tools + session id', () => {
  it('registers injected extra tools in the custom tool list', async () => {
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'x', tools: [] },
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [makeProbeTool({ sessionId: null }, () => backend.getCurrentSessionId())],
    );
    // buildCustomTools is private; assert via the public accessor that the
    // backend stored the extra tools.
    expect(backend.listExtraToolNames()).toContain('probe_session');
  });

  it('exposes the current session id, defaulting to null before a run', () => {
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'x' },
      {},
    );
    expect(backend.getCurrentSessionId()).toBeNull();
    backend.setCurrentSessionId('conv-123');
    expect(backend.getCurrentSessionId()).toBe('conv-123');
  });
});

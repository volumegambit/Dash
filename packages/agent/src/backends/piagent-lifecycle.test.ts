import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentState } from '../types.js';
import { PiAgentBackend } from './piagent.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function state(conversationId: string): AgentState {
  return {
    channelId: 'web',
    conversationId,
    model: 'anthropic/claude-sonnet-4-5',
    message: 'start',
    systemPrompt: 'test',
  };
}

describe('PiAgentBackend direct run lifecycle', () => {
  it('claims ownership before first pull and keeps it through an early seal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dash-pi-lifecycle-'));
    roots.push(root);
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: 'test', tools: [] },
      { anthropic: 'sk-test-no-network' },
      undefined,
      join(root, 'sessions'),
    );
    await backend.start(root);

    const first = backend.run(state('shared'), {
      runId: 'run-1',
      onSteerConsumed: async () => {},
    });
    await expect(backend.sealSteering('run-1')).resolves.toEqual([]);
    expect(() => backend.run(state('shared'), {})).toThrow(/run while another run is in progress/);

    await first.return(undefined as never);
    const replacement = backend.run(state('shared'), {});
    await replacement.return(undefined as never);
    await backend.stop();
  });
});

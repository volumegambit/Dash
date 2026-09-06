import { PiAgentBackend } from '@dash/agent';
import { describe, expect, it, vi } from 'vitest';
import { createAgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';

describe('AgentChatCoordinator real Pi backend contract', () => {
  it('routes legacy and typed steering through distinct public Pi capabilities', async () => {
    const backend = new PiAgentBackend({
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'test',
    });
    vi.spyOn(backend, 'start').mockResolvedValue();
    vi.spyOn(backend, 'stop').mockResolvedValue();
    vi.spyOn(backend, 'run').mockImplementation(async function* () {});
    const typedSteer = vi.spyOn(backend, 'steer').mockResolvedValue({ accepted: true });
    const legacySteer = vi.spyOn(backend, 'steerLegacy').mockResolvedValue();
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'pi-steering-contract',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'test',
    });
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 1,
      createBackend: async () => backend,
    });
    for await (const _event of agents.chat({
      agentId: id,
      conversationId: 'shared',
      text: 'warm',
    })) {
      // consume
    }
    const images = [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'abc' }];

    await agents.steer(id, 'shared', 'legacy text', images);
    await expect(
      agents.steerRun(id, 'shared', 'run-1', 'input-1', { text: 'typed text' }),
    ).resolves.toEqual({ accepted: true });

    expect(legacySteer).toHaveBeenCalledWith('legacy text', images);
    expect(typedSteer).toHaveBeenCalledWith('run-1', 'input-1', { text: 'typed text' });
    await agents.stop();
  });
});

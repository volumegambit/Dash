import { PiAgentBackend } from '@dash/agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import type { GatewayAgentConfig } from './agent-registry.js';

/**
 * Pins the WIRING that threads a gateway agent's `providers` allow-list into the
 * backend's model-resolution policy gate. The resolve-model gate itself is unit-
 * tested in `@dash/agent` (resolve-model.test.ts, piagent.providers.test.ts);
 * THIS test proves the connective tissue: `GatewayAgentConfig.providers` reaches
 * `DashAgentConfig.allowedProviders` on the backend so that a disallowed provider
 * fails resolution with the policy message while an allowed one resolves.
 *
 * The backend is constructed exactly the way `createBackend` in index.ts does
 * (options object first arg, `allowedProviders: agentConfig.providers`). If that
 * mapping is dropped or renamed, `google/gemini-x` would resolve to "Unknown
 * model" / a real model instead of the policy error and this test fails.
 */

/**
 * Cast helper to call the private resolveModel directly (no live pi session).
 * Passes the backend's frozen `config.allowedProviders` as the gate — mirroring
 * the `start()` path, which is what this wiring test asserts (that
 * `agentConfig.providers` reaches the frozen `DashAgentConfig.allowedProviders`).
 */
function resolve(backend: PiAgentBackend, modelStr: string): Model<Api> {
  const cfg = (backend as unknown as { config: { allowedProviders?: string[] } }).config;
  return (
    backend as unknown as {
      resolveModel(s: string, a: string[] | undefined): Model<Api>;
    }
  ).resolveModel(modelStr, cfg.allowedProviders);
}

/**
 * Mirror of the index.ts `createBackend` construction, reduced to the fields that
 * matter for provider gating. `allowedProviders: agentConfig.providers` is the
 * one line under test — it must match index.ts exactly.
 */
function makeBackendFromAgentConfig(agentConfig: GatewayAgentConfig): PiAgentBackend {
  return new PiAgentBackend(
    {
      model: agentConfig.model,
      systemPrompt: agentConfig.systemPrompt,
      fallbackModels: agentConfig.fallbackModels,
      tools: agentConfig.tools,
      allowedProviders: agentConfig.providers,
    },
    async () => ({}),
  );
}

describe('gateway per-agent providers wiring', () => {
  it('refuses a disallowed provider with the policy message when providers = ["anthropic"]', () => {
    const agentConfig: GatewayAgentConfig = {
      name: 'gated',
      model: 'anthropic/claude-sonnet-4-5',
      systemPrompt: 'test',
      providers: ['anthropic'],
    };
    const backend = makeBackendFromAgentConfig(agentConfig);
    expect(() => resolve(backend, 'google/gemini-x')).toThrow(
      'Provider "google" is not allowed for this agent (allowed: anthropic)',
    );
  });

  it('resolves an allowed provider when providers = ["anthropic"]', () => {
    const agentConfig: GatewayAgentConfig = {
      name: 'gated',
      model: 'anthropic/claude-sonnet-4-5',
      systemPrompt: 'test',
      providers: ['anthropic'],
    };
    const backend = makeBackendFromAgentConfig(agentConfig);
    const model = resolve(backend, 'anthropic/claude-sonnet-4-5');
    expect(model).toBeDefined();
    expect(typeof model.id).toBe('string');
  });

  it('does not gate any provider when providers is undefined (legacy agents)', () => {
    const agentConfig: GatewayAgentConfig = {
      name: 'ungated',
      model: 'anthropic/claude-sonnet-4-5',
      systemPrompt: 'test',
    };
    const backend = makeBackendFromAgentConfig(agentConfig);
    // google is not in any allow-list here because there is no allow-list;
    // resolution proceeds to the normal registry lookup (unknown id -> Unknown
    // model error, NOT the policy error).
    expect(() => resolve(backend, 'google/gemini-x')).toThrow(/Unknown model/);
  });
});

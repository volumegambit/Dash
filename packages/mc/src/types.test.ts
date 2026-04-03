import { describe, it, expect } from 'vitest';
import type { AgentDeployment } from './types.js';

describe('AgentDeployment type', () => {
  it('accepts credentialStatus, credentialProvider, and credentialDetail fields', () => {
    const deployment: AgentDeployment = {
      id: 'test-1',
      name: 'test-agent',
      target: 'local',
      status: 'running',
      config: { channels: {} },
      createdAt: '2026-01-01T00:00:00Z',
      credentialStatus: 'missing',
      credentialProvider: 'anthropic',
      credentialDetail: 'Key "default" for anthropic not found',
    };
    expect(deployment.credentialStatus).toBe('missing');
    expect(deployment.credentialProvider).toBe('anthropic');
    expect(deployment.credentialDetail).toBe('Key "default" for anthropic not found');
  });

  it('allows credentialStatus to be ok, missing, or invalid', () => {
    const base = {
      id: 'x',
      name: 'x',
      target: 'local' as const,
      status: 'running' as const,
      config: { channels: {} },
      createdAt: '',
    };
    const ok: AgentDeployment = { ...base, credentialStatus: 'ok' };
    const missing: AgentDeployment = { ...base, credentialStatus: 'missing' };
    const invalid: AgentDeployment = { ...base, credentialStatus: 'invalid' };
    expect(ok.credentialStatus).toBe('ok');
    expect(missing.credentialStatus).toBe('missing');
    expect(invalid.credentialStatus).toBe('invalid');
  });
});

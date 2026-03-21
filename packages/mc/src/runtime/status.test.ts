import type { AgentDeployment } from '../types.js';
import { resolveRuntimeStatus } from './status.js';

function makeDeployment(overrides: Partial<AgentDeployment> = {}): AgentDeployment {
  return {
    id: 'test-id',
    name: 'test-agent',
    target: 'local',
    status: 'running',
    config: { target: 'local', channels: {} },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('resolveRuntimeStatus', () => {
  it('maps running status', async () => {
    const result = await resolveRuntimeStatus(makeDeployment({ status: 'running' }));
    expect(result.state).toBe('running');
  });

  it('maps provisioning to starting', async () => {
    const result = await resolveRuntimeStatus(makeDeployment({ status: 'provisioning' }));
    expect(result.state).toBe('starting');
  });

  it('maps error status with errorMessage', async () => {
    const result = await resolveRuntimeStatus(
      makeDeployment({ status: 'error', errorMessage: 'something broke' }),
    );
    expect(result.state).toBe('error');
    expect(result.error).toBe('something broke');
  });

  it('maps stopped status', async () => {
    const result = await resolveRuntimeStatus(makeDeployment({ status: 'stopped' }));
    expect(result.state).toBe('stopped');
  });
});

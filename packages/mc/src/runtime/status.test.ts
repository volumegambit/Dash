import type { AgentDeployment } from '../types.js';
import { type ProcessSnapshot, resolveRuntimeStatus } from './status.js';

function makeDeployment(overrides: Partial<AgentDeployment> = {}): AgentDeployment {
  return {
    id: 'test-id',
    name: 'test-agent',
    target: 'local',
    status: 'running',
    config: { target: 'local', channels: {} },
    createdAt: new Date().toISOString(),
    managementPort: 9100,
    chatPort: 9101,
    agentServerPid: 1234,
    gatewayPid: 5678,
    ...overrides,
  };
}

describe('resolveRuntimeStatus', () => {
  describe('path 1: in-memory process state', () => {
    it('returns running with uptime when process is alive', () => {
      const snapshot: ProcessSnapshot = {
        agentServer: { exitCode: null, pid: 1234 },
        gateway: { pid: 5678 },
        startTime: Date.now() - 10_000,
      };
      const result = resolveRuntimeStatus(snapshot, makeDeployment());
      expect(result.state).toBe('running');
      expect(result.agentServerPid).toBe(1234);
      expect(result.gatewayPid).toBe(5678);
      expect(result.uptime).toBeGreaterThanOrEqual(9000);
      expect(result.managementPort).toBe(9100);
      expect(result.chatPort).toBe(9101);
    });

    it('returns stopped when in-memory process has exited', () => {
      const snapshot: ProcessSnapshot = {
        agentServer: { exitCode: 1, pid: 1234 },
        gateway: { pid: 5678 },
        startTime: Date.now() - 5000,
      };
      const result = resolveRuntimeStatus(snapshot, makeDeployment());
      expect(result.state).toBe('stopped');
      expect(result.agentServerPid).toBe(1234);
    });

    it('handles missing gateway', () => {
      const snapshot: ProcessSnapshot = {
        agentServer: { exitCode: null, pid: 1234 },
        startTime: Date.now(),
      };
      const result = resolveRuntimeStatus(snapshot, makeDeployment());
      expect(result.state).toBe('running');
      expect(result.gatewayPid).toBeUndefined();
    });
  });

  describe('path 2: PID liveness check', () => {
    it('returns running when PID is alive', () => {
      const deployment = makeDeployment({ agentServerPid: 9999 });
      const result = resolveRuntimeStatus(null, deployment, () => true);
      expect(result.state).toBe('running');
      expect(result.agentServerPid).toBe(9999);
      expect(result.gatewayPid).toBe(5678);
    });

    it('falls through to path 3 when PID is dead', () => {
      const deployment = makeDeployment({ status: 'running', agentServerPid: 9999 });
      const result = resolveRuntimeStatus(null, deployment, () => false);
      expect(result.state).toBe('stopped');
    });
  });

  describe('path 3: registry fallback', () => {
    it('maps stopped status', () => {
      const deployment = makeDeployment({ status: 'stopped', agentServerPid: undefined });
      const result = resolveRuntimeStatus(null, deployment);
      expect(result.state).toBe('stopped');
    });

    it('maps error status', () => {
      const deployment = makeDeployment({ status: 'error', agentServerPid: undefined });
      const result = resolveRuntimeStatus(null, deployment);
      expect(result.state).toBe('error');
    });

    it('maps provisioning to starting', () => {
      const deployment = makeDeployment({ status: 'provisioning', agentServerPid: undefined });
      const result = resolveRuntimeStatus(null, deployment);
      expect(result.state).toBe('starting');
    });

    it('maps stale running (dead PID) to stopped', () => {
      const deployment = makeDeployment({ status: 'running', agentServerPid: 9999 });
      const result = resolveRuntimeStatus(null, deployment, () => false);
      expect(result.state).toBe('stopped');
    });

    it('returns error for unknown status', () => {
      const deployment = makeDeployment({ agentServerPid: undefined });
      (deployment as { status: string }).status = 'bogus';
      const result = resolveRuntimeStatus(null, deployment);
      expect(result.state).toBe('error');
    });
  });
});

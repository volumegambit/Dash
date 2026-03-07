import type { AgentDeployment } from '../types.js';
import type { RuntimeStatus } from './types.js';

export interface ProcessSnapshot {
  agentServer: { exitCode: number | null; pid?: number };
  gateway?: { pid?: number };
  startTime: number;
}

export function resolveRuntimeStatus(
  processState: ProcessSnapshot | null,
  deployment: AgentDeployment,
  isPidAlive?: (pid: number) => boolean,
): RuntimeStatus {
  const checkPid =
    isPidAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

  // Path 1: Process tracked in memory
  if (processState) {
    const agentRunning = processState.agentServer.exitCode === null;
    return {
      state: agentRunning ? 'running' : 'stopped',
      agentServerPid: processState.agentServer.pid,
      gatewayPid: processState.gateway?.pid,
      managementPort: deployment.managementPort,
      chatPort: deployment.chatPort,
      uptime: Date.now() - processState.startTime,
    };
  }

  // Path 2: Not in memory — check PID liveness
  if (deployment.agentServerPid) {
    if (checkPid(deployment.agentServerPid)) {
      return {
        state: 'running',
        agentServerPid: deployment.agentServerPid,
        gatewayPid: deployment.gatewayPid,
        managementPort: deployment.managementPort,
        chatPort: deployment.chatPort,
      };
    }
  }

  // Path 3: Fallback — map registry status
  const stateMap: Record<string, RuntimeStatus['state']> = {
    running: 'stopped', // Registry says running but PID is dead
    stopped: 'stopped',
    error: 'error',
    provisioning: 'starting',
  };
  return {
    state: stateMap[deployment.status] ?? 'error',
    managementPort: deployment.managementPort,
    chatPort: deployment.chatPort,
  };
}

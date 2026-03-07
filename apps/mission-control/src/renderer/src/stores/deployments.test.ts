import type { AgentDeployment } from '@dash/mc';
import { mockApi } from '../../../../vitest.setup.js';
import { useDeploymentsStore } from './deployments.js';

function makeDeployment(overrides: Partial<AgentDeployment> = {}): AgentDeployment {
  return {
    id: 'dep-1',
    name: 'Test Agent',
    target: 'local',
    status: 'running',
    config: { target: 'local', channels: {} },
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  useDeploymentsStore.setState({
    deployments: [],
    loading: false,
    error: null,
    logLines: {},
  });
});

describe('appendLogLine', () => {
  it('creates a new array for an unknown deployment id', () => {
    useDeploymentsStore.getState().appendLogLine('new-id', 'hello');

    const { logLines } = useDeploymentsStore.getState();
    expect(logLines['new-id']).toEqual(['hello']);
  });

  it('appends to an existing array', () => {
    useDeploymentsStore.setState({ logLines: { 'dep-1': ['line-1'] } });

    useDeploymentsStore.getState().appendLogLine('dep-1', 'line-2');

    const { logLines } = useDeploymentsStore.getState();
    expect(logLines['dep-1']).toEqual(['line-1', 'line-2']);
  });

  it('caps log lines at 500, dropping the oldest line', () => {
    const initial = Array.from({ length: 500 }, (_, i) => `line-${i}`);
    useDeploymentsStore.setState({ logLines: { 'dep-1': initial } });

    useDeploymentsStore.getState().appendLogLine('dep-1', 'line-500');

    const { logLines } = useDeploymentsStore.getState();
    expect(logLines['dep-1']).toHaveLength(500);
    expect(logLines['dep-1']![0]).toBe('line-1');
    expect(logLines['dep-1']![499]).toBe('line-500');
  });
});

describe('handleStatusChange', () => {
  it('updates the matching deployment status and leaves others unchanged', () => {
    const dep1 = makeDeployment({ id: 'dep-1', status: 'running' });
    const dep2 = makeDeployment({ id: 'dep-2', status: 'stopped', name: 'Other' });
    useDeploymentsStore.setState({ deployments: [dep1, dep2] });

    useDeploymentsStore.getState().handleStatusChange('dep-1', 'error');

    const { deployments } = useDeploymentsStore.getState();
    expect(deployments[0]!.status).toBe('error');
    expect(deployments[1]!.status).toBe('stopped');
    expect(deployments[1]!.name).toBe('Other');
  });
});

describe('loadDeployments', () => {
  it('sets loading=false and error=null on success', async () => {
    const deps = [makeDeployment()];
    mockApi.deploymentsList.mockResolvedValue(deps);

    await useDeploymentsStore.getState().loadDeployments();

    const state = useDeploymentsStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.deployments).toEqual(deps);
  });

  it('sets error on failure', async () => {
    mockApi.deploymentsList.mockRejectedValue(new Error('network down'));

    await useDeploymentsStore.getState().loadDeployments();

    const state = useDeploymentsStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBe('network down');
  });
});

describe('subscribeLogs', () => {
  it('initializes log array for new id and calls IPC', () => {
    useDeploymentsStore.getState().subscribeLogs('new-id');

    const { logLines } = useDeploymentsStore.getState();
    expect(logLines['new-id']).toEqual([]);
    expect(mockApi.deploymentsLogsSubscribe).toHaveBeenCalledWith('new-id');
  });

  it('preserves existing log lines for known id', () => {
    useDeploymentsStore.setState({ logLines: { 'dep-1': ['existing-line'] } });

    useDeploymentsStore.getState().subscribeLogs('dep-1');

    const { logLines } = useDeploymentsStore.getState();
    expect(logLines['dep-1']).toEqual(['existing-line']);
    expect(mockApi.deploymentsLogsSubscribe).toHaveBeenCalledWith('dep-1');
  });
});

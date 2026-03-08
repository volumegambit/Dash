import type { AgentDeployment, RuntimeStatus } from '@dash/mc';
import { create } from 'zustand';
import { type DeployWithConfigOptions, RendererDeploymentError } from '../../../shared/ipc';

const MAX_LOG_LINES = 500;

interface DeploymentsState {
  deployments: AgentDeployment[];
  loading: boolean;
  error: string | null;
  logLines: Record<string, string[]>;

  loadDeployments(): Promise<void>;
  deploy(configDir: string): Promise<string>;
  deployWithConfig(options: DeployWithConfigOptions): Promise<string>;
  stop(id: string): Promise<void>;
  remove(id: string, deleteWorkspace?: boolean): Promise<void>;
  getStatus(id: string): Promise<RuntimeStatus>;
  updateConfig(id: string, patch: { model?: string; fallbackModels?: string[] }): Promise<void>;
  subscribeLogs(id: string): void;
  unsubscribeLogs(id: string): void;
  appendLogLine(id: string, line: string): void;
  handleStatusChange(id: string, status: string): void;
}

export const useDeploymentsStore = create<DeploymentsState>((set, get) => ({
  deployments: [],
  loading: true,
  error: null,
  logLines: {},

  async loadDeployments() {
    set({ loading: true, error: null });
    try {
      const deployments = await window.api.deploymentsList();
      set({ deployments, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async deploy(configDir: string) {
    set({ error: null });
    try {
      const id = await window.api.deploymentsDeploy(configDir);
      await get().loadDeployments();
      const deployment = get().deployments.find((d) => d.id === id);
      if (deployment?.status === 'error') {
        const err = new RendererDeploymentError(
          deployment.errorMessage ?? 'Deployment startup failed',
          id,
          deployment.startupLogs ?? [],
        );
        set({ error: err.message });
        throw err;
      }
      return id;
    } catch (err) {
      if (!(err instanceof RendererDeploymentError)) {
        set({ error: (err as Error).message });
      }
      throw err;
    }
  },

  async deployWithConfig(options: DeployWithConfigOptions) {
    set({ error: null });
    try {
      const id = await window.api.deploymentsDeployWithConfig(options);
      await get().loadDeployments();
      const deployment = get().deployments.find((d) => d.id === id);
      if (deployment?.status === 'error') {
        const err = new RendererDeploymentError(
          deployment.errorMessage ?? 'Deployment startup failed',
          id,
          deployment.startupLogs ?? [],
        );
        set({ error: err.message });
        throw err;
      }
      return id;
    } catch (err) {
      if (!(err instanceof RendererDeploymentError)) {
        set({ error: (err as Error).message });
      }
      throw err;
    }
  },

  async stop(id: string) {
    try {
      await window.api.deploymentsStop(id);
      await get().loadDeployments();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async remove(id: string, deleteWorkspace?: boolean) {
    try {
      await window.api.deploymentsRemove(id, deleteWorkspace);
      await get().loadDeployments();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async getStatus(id: string) {
    try {
      return await window.api.deploymentsGetStatus(id);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async updateConfig(id: string, patch: { model?: string; fallbackModels?: string[] }) {
    try {
      await window.api.deploymentsUpdateConfig(id, patch);
      await get().loadDeployments();
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  subscribeLogs(id: string) {
    set((state) => ({
      logLines: { ...state.logLines, [id]: state.logLines[id] ?? [] },
    }));
    window.api.deploymentsLogsSubscribe(id);
  },

  unsubscribeLogs(id: string) {
    window.api.deploymentsLogsUnsubscribe(id);
  },

  appendLogLine(id: string, line: string) {
    set((state) => {
      const existing = state.logLines[id] ?? [];
      const updated = [...existing, line];
      // Cap at MAX_LOG_LINES for renderer performance
      const trimmed = updated.length > MAX_LOG_LINES ? updated.slice(-MAX_LOG_LINES) : updated;
      return { logLines: { ...state.logLines, [id]: trimmed } };
    });
  },

  handleStatusChange(id: string, status: string) {
    set((state) => ({
      deployments: state.deployments.map((d) =>
        d.id === id ? { ...d, status: status as AgentDeployment['status'] } : d,
      ),
    }));
  },
}));

// Set up global event listeners for push events from main process
let cleanupLog: (() => void) | null = null;
let cleanupStatus: (() => void) | null = null;

export function initDeploymentListeners(): void {
  if (cleanupLog) return; // Already initialized

  cleanupLog = window.api.onDeploymentLog((id, line) => {
    useDeploymentsStore.getState().appendLogLine(id, line);
  });

  cleanupStatus = window.api.onDeploymentStatusChange((id, status) => {
    useDeploymentsStore.getState().handleStatusChange(id, status);
  });
}

export function cleanupDeploymentListeners(): void {
  cleanupLog?.();
  cleanupStatus?.();
  cleanupLog = null;
  cleanupStatus = null;
}

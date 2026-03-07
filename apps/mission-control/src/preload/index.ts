import { contextBridge, ipcRenderer } from 'electron';
import type { MissionControlAPI } from '../shared/ipc';

const api: MissionControlAPI = {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('openExternal', url),

  // Setup
  setupGetStatus: () => ipcRenderer.invoke('setup:getStatus'),

  // Chat
  chatConnect: (gatewayUrl: string) => ipcRenderer.invoke('chat:connect', gatewayUrl),
  chatDisconnect: () => ipcRenderer.invoke('chat:disconnect'),
  chatSend: (conversationId: string, text: string) =>
    ipcRenderer.invoke('chat:send', conversationId, text),
  chatOnResponse: (callback: (conversationId: string, text: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, conversationId: string, text: string) =>
      callback(conversationId, text);
    ipcRenderer.on('chat:response', listener);
    return () => ipcRenderer.removeListener('chat:response', listener);
  },
  chatOnError: (callback: (conversationId: string, error: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, conversationId: string, error: string) =>
      callback(conversationId, error);
    ipcRenderer.on('chat:error', listener);
    return () => ipcRenderer.removeListener('chat:error', listener);
  },

  // Secrets
  secretsNeedsSetup: () => ipcRenderer.invoke('secrets:needsSetup'),
  secretsNeedsMigration: () => ipcRenderer.invoke('secrets:needsMigration'),
  secretsIsUnlocked: () => ipcRenderer.invoke('secrets:isUnlocked'),
  secretsSetup: (password: string) => ipcRenderer.invoke('secrets:setup', password),
  secretsUnlock: (password: string) => ipcRenderer.invoke('secrets:unlock', password),
  secretsLock: () => ipcRenderer.invoke('secrets:lock'),
  secretsList: () => ipcRenderer.invoke('secrets:list'),
  secretsGet: (key: string) => ipcRenderer.invoke('secrets:get', key),
  secretsSet: (key: string, value: string) => ipcRenderer.invoke('secrets:set', key, value),
  secretsDelete: (key: string) => ipcRenderer.invoke('secrets:delete', key),

  // Deployments
  deploymentsList: () => ipcRenderer.invoke('deployments:list'),
  deploymentsGet: (id: string) => ipcRenderer.invoke('deployments:get', id),
  deploymentsDeploy: (configDir: string) => ipcRenderer.invoke('deployments:deploy', configDir),
  deploymentsDeployWithConfig: (options) =>
    ipcRenderer.invoke('deployments:deployWithConfig', options),
  deploymentsStop: (id: string) => ipcRenderer.invoke('deployments:stop', id),
  deploymentsRemove: (id: string) => ipcRenderer.invoke('deployments:remove', id),
  deploymentsGetStatus: (id: string) => ipcRenderer.invoke('deployments:getStatus', id),
  deploymentsLogsSubscribe: (id: string) => ipcRenderer.invoke('deployments:logs:subscribe', id),
  deploymentsLogsUnsubscribe: (id: string) =>
    ipcRenderer.invoke('deployments:logs:unsubscribe', id),

  // Deployment events
  onDeploymentLog: (callback: (id: string, line: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, id: string, line: string) =>
      callback(id, line);
    ipcRenderer.on('deployment:log', listener);
    return () => ipcRenderer.removeListener('deployment:log', listener);
  },
  onDeploymentStatusChange: (callback: (id: string, status: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, id: string, status: string) =>
      callback(id, status);
    ipcRenderer.on('deployment:statusChange', listener);
    return () => ipcRenderer.removeListener('deployment:statusChange', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);

import { contextBridge, ipcRenderer } from 'electron';
import type { MissionControlAPI } from '../shared/ipc';

const api: MissionControlAPI = {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

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
};

contextBridge.exposeInMainWorld('api', api);

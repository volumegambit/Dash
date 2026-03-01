import { contextBridge, ipcRenderer } from 'electron';
import type { MissionControlAPI } from '../shared/ipc';

const api: MissionControlAPI = {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
};

contextBridge.exposeInMainWorld('api', api);

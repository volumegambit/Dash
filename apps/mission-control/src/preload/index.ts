import { contextBridge, ipcRenderer } from 'electron';
import type { McAgentEvent, MissionControlAPI } from '../shared/ipc.js';

const api: MissionControlAPI = {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('openExternal', url),
  openPath: (path: string) => ipcRenderer.invoke('openPath', path),
  dialogOpenDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),

  // Setup
  setupGetStatus: () => ipcRenderer.invoke('setup:getStatus'),

  // Chat
  chatListConversations: (deploymentId) =>
    ipcRenderer.invoke('chat:listConversations', deploymentId),
  chatCreateConversation: (deploymentId, agentName) =>
    ipcRenderer.invoke('chat:createConversation', deploymentId, agentName),
  chatGetMessages: (conversationId) => ipcRenderer.invoke('chat:getMessages', conversationId),
  chatRenameConversation: (conversationId, title) =>
    ipcRenderer.invoke('chat:renameConversation', conversationId, title),
  chatDeleteConversation: (conversationId) =>
    ipcRenderer.invoke('chat:deleteConversation', conversationId),
  chatSendMessage: (conversationId, text, images) =>
    ipcRenderer.invoke('chat:sendMessage', conversationId, text, images),
  chatCancel: (conversationId) => ipcRenderer.invoke('chat:cancel', conversationId),
  chatAnswerQuestion: (conversationId: string, questionId: string, answer: string) =>
    ipcRenderer.invoke('chat:answer-question', conversationId, questionId, answer),
  chatOnEvent: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      conversationId: string,
      event: McAgentEvent,
    ) => callback(conversationId, event);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },
  chatOnDone: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, conversationId: string) =>
      callback(conversationId);
    ipcRenderer.on('chat:done', listener);
    return () => ipcRenderer.removeListener('chat:done', listener);
  },
  chatOnError: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, conversationId: string, error: string) =>
      callback(conversationId, error);
    ipcRenderer.on('chat:error', listener);
    return () => ipcRenderer.removeListener('chat:error', listener);
  },

  // Codex OAuth (OpenAI)
  codexStartOAuth: (keyName: string) => ipcRenderer.invoke('codex:startOAuth', keyName),
  codexRefreshToken: (keyName: string) => ipcRenderer.invoke('codex:refreshToken', keyName),

  // Claude OAuth (Anthropic)
  claudePrepareOAuth: () => ipcRenderer.invoke('claude:prepareOAuth'),
  claudeCompleteOAuth: (keyName: string, code: string, state: string, verifier: string) =>
    ipcRenderer.invoke('claude:completeOAuth', keyName, code, state, verifier),

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
  deploymentsRestart: (id: string) => ipcRenderer.invoke('deployments:restart', id),
  deploymentsRemove: (id: string, deleteWorkspace?: boolean) =>
    ipcRenderer.invoke('deployments:remove', id, deleteWorkspace),
  deploymentsGetStatus: (id: string) => ipcRenderer.invoke('deployments:getStatus', id),
  deploymentsLogsSubscribe: (id: string) => ipcRenderer.invoke('deployments:logs:subscribe', id),
  deploymentsLogsUnsubscribe: (id: string) =>
    ipcRenderer.invoke('deployments:logs:unsubscribe', id),
  deploymentsUpdateConfig: (id, patch) => ipcRenderer.invoke('deployments:updateConfig', id, patch),
  deploymentsMcpList: (id: string, agentName: string) =>
    ipcRenderer.invoke('deployments:mcpList', id, agentName),
  deploymentsMcpAdd: (id: string, agentName: string, serverName: string, config: unknown) =>
    ipcRenderer.invoke('deployments:mcpAdd', id, agentName, serverName, config),
  deploymentsMcpRemove: (id: string, agentName: string, serverName: string) =>
    ipcRenderer.invoke('deployments:mcpRemove', id, agentName, serverName),
  deploymentsGetChannelHealth: (id: string) =>
    ipcRenderer.invoke('deployments:getChannelHealth', id),

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

  // Messaging Apps
  messagingAppsList: () => ipcRenderer.invoke('messagingApps:list'),
  messagingAppsGet: (id: string) => ipcRenderer.invoke('messagingApps:get', id),
  messagingAppsCreate: (app, token) => ipcRenderer.invoke('messagingApps:create', app, token),
  messagingAppsUpdate: (
    id: string,
    patch: Parameters<MissionControlAPI['messagingAppsUpdate']>[1],
  ) => ipcRenderer.invoke('messagingApps:update', id, patch),
  messagingAppsDelete: (id: string) => ipcRenderer.invoke('messagingApps:delete', id),
  messagingAppsVerifyTelegramToken: (token: string) =>
    ipcRenderer.invoke('messagingApps:verifyTelegramToken', token),
  whatsappStartPairing: (appId: string) => ipcRenderer.invoke('whatsapp:startPairing', appId),
  whatsappOnQr: (callback: (appId: string, qrDataUrl: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, appId: string, qrDataUrl: string) =>
      callback(appId, qrDataUrl);
    ipcRenderer.on('whatsapp:qr', listener);
    return () => ipcRenderer.removeListener('whatsapp:qr', listener);
  },
  whatsappOnLinked: (callback: (appId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, appId: string) => callback(appId);
    ipcRenderer.on('whatsapp:linked', listener);
    return () => ipcRenderer.removeListener('whatsapp:linked', listener);
  },
  whatsappOnError: (callback: (appId: string, message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, appId: string, message: string) =>
      callback(appId, message);
    ipcRenderer.on('whatsapp:error', listener);
    return () => ipcRenderer.removeListener('whatsapp:error', listener);
  },
  messagingAppsCreateWhatsApp: (
    appId: string,
    app: Parameters<MissionControlAPI['messagingAppsCreateWhatsApp']>[1],
  ) => ipcRenderer.invoke('messagingApps:createWhatsApp', appId, app),

  // Settings
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),

  // Skills
  skillsList: (deploymentId, agentName) =>
    ipcRenderer.invoke('skills:list', deploymentId, agentName),
  skillsGet: (deploymentId, agentName, skillName) =>
    ipcRenderer.invoke('skills:get', deploymentId, agentName, skillName),
  skillsUpdateContent: (deploymentId, agentName, skillName, content) =>
    ipcRenderer.invoke('skills:updateContent', deploymentId, agentName, skillName, content),
  skillsCreate: (deploymentId, agentName, name, description, content) =>
    ipcRenderer.invoke('skills:create', deploymentId, agentName, name, description, content),
  skillsGetConfig: (deploymentId, agentName) =>
    ipcRenderer.invoke('skills:getConfig', deploymentId, agentName),
  skillsUpdateConfig: (deploymentId, agentName, config) =>
    ipcRenderer.invoke('skills:updateConfig', deploymentId, agentName, config),

  // Gateway
  gatewayGetStatus: () => ipcRenderer.invoke('gateway:getStatus'),
  gatewayOnStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: string) =>
      callback(status as Parameters<typeof callback>[0]);
    ipcRenderer.on('gateway:status', listener);
    return () => ipcRenderer.removeListener('gateway:status', listener);
  },

  // Models & Tools
  modelsList: () => ipcRenderer.invoke('models:list'),
  modelsRefresh: () => ipcRenderer.invoke('models:refresh'),
  toolsList: () => ipcRenderer.invoke('tools:list'),

  // Credentials
  onCredentialsPushFailed: (
    callback: (failures: { deploymentId: string; name: string; error: string }[]) => void,
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      failures: { deploymentId: string; name: string; error: string }[],
    ) => callback(failures);
    ipcRenderer.on('credentials:pushFailed', handler);
    return () => ipcRenderer.removeListener('credentials:pushFailed', handler);
  },

  // Updates
  onUpdateAvailable: (callback: (info: { version: string }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, info: { version: string }) => callback(info);
    ipcRenderer.on('update:available', handler);
    return () => ipcRenderer.removeListener('update:available', handler);
  },
};

contextBridge.exposeInMainWorld('api', api);

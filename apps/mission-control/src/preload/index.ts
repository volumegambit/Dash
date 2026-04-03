import { contextBridge, ipcRenderer } from 'electron';
import type { McAgentEvent, McpStatusChange, MissionControlAPI } from '../shared/ipc.js';

const api: MissionControlAPI = {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('openExternal', url),
  openPath: (path: string) => ipcRenderer.invoke('openPath', path),
  dialogOpenDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),

  // Agents
  agentsList: () => ipcRenderer.invoke('agents:list'),
  agentsGet: (id: string) => ipcRenderer.invoke('agents:get', id),
  agentsCreate: (config) => ipcRenderer.invoke('agents:create', config),
  agentsUpdate: (id, patch) => ipcRenderer.invoke('agents:update', id, patch),
  agentsRemove: (id) => ipcRenderer.invoke('agents:remove', id),
  agentsDisable: (id) => ipcRenderer.invoke('agents:disable', id),
  agentsEnable: (id) => ipcRenderer.invoke('agents:enable', id),

  // Channels
  channelsList: () => ipcRenderer.invoke('channels:list'),
  channelsGet: (name) => ipcRenderer.invoke('channels:get', name),
  channelsCreate: (config) => ipcRenderer.invoke('channels:create', config),
  channelsUpdate: (name, patch) => ipcRenderer.invoke('channels:update', name, patch),
  channelsRemove: (name) => ipcRenderer.invoke('channels:remove', name),
  channelsVerifyTelegramToken: (token) =>
    ipcRenderer.invoke('channels:verifyTelegramToken', token),

  // Credentials
  credentialsSet: (key, value) => ipcRenderer.invoke('credentials:set', key, value),
  credentialsList: () => ipcRenderer.invoke('credentials:list'),
  credentialsRemove: (key) => ipcRenderer.invoke('credentials:remove', key),

  // Codex OAuth (OpenAI)
  codexStartOAuth: (keyName: string) => ipcRenderer.invoke('codex:startOAuth', keyName),
  codexRefreshToken: (keyName: string) => ipcRenderer.invoke('codex:refreshToken', keyName),

  // Claude OAuth (Anthropic)
  claudePrepareOAuth: () => ipcRenderer.invoke('claude:prepareOAuth'),
  claudeCompleteOAuth: (keyName: string, code: string, state: string, verifier: string) =>
    ipcRenderer.invoke('claude:completeOAuth', keyName, code, state, verifier),

  // Chat
  chatCreateConversation: (agentId) => ipcRenderer.invoke('chat:createConversation', agentId),
  chatListConversations: () => ipcRenderer.invoke('chat:listConversations'),
  chatGetMessages: (conversationId) => ipcRenderer.invoke('chat:getMessages', conversationId),
  chatSend: (conversationId, text, images) =>
    ipcRenderer.invoke('chat:sendMessage', conversationId, text, images),
  chatCancel: (conversationId) => ipcRenderer.send('chat:cancel', conversationId),
  chatRenameConversation: (conversationId, title) =>
    ipcRenderer.invoke('chat:renameConversation', conversationId, title),
  chatDeleteConversation: (conversationId) =>
    ipcRenderer.invoke('chat:deleteConversation', conversationId),
  chatAnswerQuestion: (conversationId, questionId, answer) =>
    ipcRenderer.send('chat:answer-question', conversationId, questionId, answer),

  // Events
  onAgentEvent: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      conversationId: string,
      event: McAgentEvent,
    ) => callback(conversationId, event);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },
  onChatDone: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, conversationId: string) =>
      callback(conversationId);
    ipcRenderer.on('chat:done', listener);
    return () => ipcRenderer.removeListener('chat:done', listener);
  },
  onChatError: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, conversationId: string, error: string) =>
      callback(conversationId, error);
    ipcRenderer.on('chat:error', listener);
    return () => ipcRenderer.removeListener('chat:error', listener);
  },

  // Skills
  skillsList: (agentId) => ipcRenderer.invoke('skills:list', agentId),
  skillsGet: (agentId, skillName) => ipcRenderer.invoke('skills:get', agentId, skillName),
  skillsUpdateContent: (agentId, skillName, content) =>
    ipcRenderer.invoke('skills:updateContent', agentId, skillName, content),
  skillsCreate: (agentId, name, description, content) =>
    ipcRenderer.invoke('skills:create', agentId, name, description, content),
  skillsGetConfig: (agentId) => ipcRenderer.invoke('skills:getConfig', agentId),
  skillsUpdateConfig: (agentId, config) =>
    ipcRenderer.invoke('skills:updateConfig', agentId, config),

  // Settings
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),

  // Models & Tools
  modelsList: () => ipcRenderer.invoke('models:list'),
  modelsRefresh: () => ipcRenderer.invoke('models:refresh'),
  toolsList: () => ipcRenderer.invoke('tools:list'),

  // Connectors (MCP)
  mcpListConnectors: () => ipcRenderer.invoke('mcp:listConnectors'),
  mcpGetConnector: (name: string) => ipcRenderer.invoke('mcp:getConnector', name),
  mcpAddConnector: (config) => ipcRenderer.invoke('mcp:addConnector', config),
  mcpRemoveConnector: (name: string) => ipcRenderer.invoke('mcp:removeConnector', name),
  mcpReconnectConnector: (name: string) => ipcRenderer.invoke('mcp:reconnectConnector', name),
  mcpGetAllowlist: () => ipcRenderer.invoke('mcp:getAllowlist'),
  mcpSetAllowlist: (patterns: string[]) => ipcRenderer.invoke('mcp:setAllowlist', patterns),
  mcpReauthorize: (name: string) => ipcRenderer.invoke('mcp:reauthorize', name),

  onMcpStatusChanged: (callback: (change: McpStatusChange) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, change: McpStatusChange) => callback(change);
    ipcRenderer.on('mcp:statusChanged', handler);
    return () => ipcRenderer.removeListener('mcp:statusChanged', handler);
  },

  // Gateway
  gatewayGetStatus: () => ipcRenderer.invoke('gateway:getStatus'),
  gatewayOnStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: string) =>
      callback(status as Parameters<typeof callback>[0]);
    ipcRenderer.on('gateway:status', listener);
    return () => ipcRenderer.removeListener('gateway:status', listener);
  },

  // Gateway events (SSE)
  onGatewayEvent: (callback: (eventType: string, data: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, eventType: string, data: string) =>
      callback(eventType, data);
    ipcRenderer.on('gateway:event', handler);
    return () => ipcRenderer.removeListener('gateway:event', handler);
  },

  // Setup
  setupStatus: () => ipcRenderer.invoke('setup:status'),
  setupEnsureGateway: () => ipcRenderer.invoke('setup:ensureGateway'),

  // WhatsApp
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

  // Updates
  onUpdateAvailable: (callback: (info: { version: string }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, info: { version: string }) => callback(info);
    ipcRenderer.on('update:available', handler);
    return () => ipcRenderer.removeListener('update:available', handler);
  },
};

contextBridge.exposeInMainWorld('api', api);

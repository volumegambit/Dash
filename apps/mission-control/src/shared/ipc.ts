export interface MissionControlAPI {
  getVersion(): Promise<string>;

  // Chat
  chatConnect(gatewayUrl: string): Promise<void>;
  chatDisconnect(): Promise<void>;
  chatSend(conversationId: string, text: string): Promise<void>;
  chatOnResponse(callback: (conversationId: string, text: string) => void): () => void;
  chatOnError(callback: (conversationId: string, error: string) => void): () => void;

  // Secrets
  secretsNeedsSetup(): Promise<boolean>;
  secretsNeedsMigration(): Promise<boolean>;
  secretsIsUnlocked(): Promise<boolean>;
  secretsSetup(password: string): Promise<void>;
  secretsUnlock(password: string): Promise<void>;
  secretsLock(): Promise<void>;
  secretsList(): Promise<string[]>;
  secretsGet(key: string): Promise<string | null>;
  secretsSet(key: string, value: string): Promise<void>;
  secretsDelete(key: string): Promise<void>;
}

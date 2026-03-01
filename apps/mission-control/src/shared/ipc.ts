export interface MissionControlAPI {
  getVersion(): Promise<string>;

  // Chat
  chatConnect(gatewayUrl: string): Promise<void>;
  chatDisconnect(): Promise<void>;
  chatSend(conversationId: string, text: string): Promise<void>;
  chatOnResponse(callback: (conversationId: string, text: string) => void): () => void;
  chatOnError(callback: (conversationId: string, error: string) => void): () => void;
}

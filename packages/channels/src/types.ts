export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface InboundMessage {
  channelId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: Date;
  raw?: unknown;
}

export interface OutboundMessage {
  text: string;
  parseMode?: 'Markdown' | 'HTML';
}

export type MessageHandler = (msg: InboundMessage) => Promise<void>;

export type ChannelHealth = 'connected' | 'connecting' | 'disconnected' | 'needs_reauth';

export interface ChannelAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(conversationId: string, message: OutboundMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
  getHealth(): ChannelHealth;
  onHealthChange(handler: (health: ChannelHealth) => void): void;
}

export interface RouterRoutingRule {
  condition:
    | { type: 'default' }
    | { type: 'sender'; ids: string[] }
    | { type: 'group'; ids: string[] };
  agentName: string;
  allowList: string[];
  denyList: string[];
}

export interface RouterConfig {
  globalDenyList: string[];
  rules: RouterRoutingRule[];
}

export interface MessageLogEntry {
  timestamp: string;
  channelName: string;
  senderId: string;
  senderName: string;
  conversationId: string;
  text: string;
  outcome: 'routed' | 'blocked' | 'no_match';
  agentName?: string;
  blockReason?: string;
}

export type MessageLogger = (entry: MessageLogEntry) => void;

/**
 * Optional per-message hook fired after allow/deny filtering and the
 * slash-command shim, but before the message is dispatched to the agent.
 * The gateway sets this to the plugin hook engine's `runUserPromptSubmit`.
 *
 * Structural by design — `@dash/channels` has NO dependency on `@dash/plugins`;
 * the field names mirror the engine's `PromptInput`/`PromptDecision` shapes so
 * the host can adapt the engine to this signature with a thin closure.
 *
 * Contract (enforced by the router/gateway, not this type):
 * - `block: true` → the message is NOT dispatched. If `reason` is present it is
 *   sent back to the sender; otherwise the message is silently dropped.
 * - `additionalContext` → prepended to the prompt text before dispatch.
 * - The caller wraps invocation in try/catch and FAILS OPEN: if the hook
 *   throws, the original message is dispatched unchanged.
 */
export type MessageHook = (input: {
  prompt: string;
  channel: string;
  conversationId: string;
  senderId: string;
}) => Promise<{ block: boolean; reason?: string; additionalContext?: string }>;

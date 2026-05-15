export type RoutingCondition =
  | { type: 'default' }
  | { type: 'sender'; ids: string[] }
  | { type: 'group'; ids: string[] };

export interface RoutingRule {
  id: string;
  label?: string;
  condition: RoutingCondition;
  targetAgentName: string;
  allowList: string[]; // empty = allow all matched senders
  denyList: string[]; // always block these senders from this agent
}

export interface MessagingApp {
  id: string;
  name: string; // user-given, e.g. "Family Group Bot"
  /**
   * Adapter id resolved against the gateway's adapter registry, e.g.
   * `'telegram'` or `'whatsapp'`. Stored as a free string so adding a new
   * adapter requires no edits here; UI surfaces fall back gracefully on
   * unknown ids.
   */
  type: string;
  credentialsKey: string; // key in the credentials store, e.g. 'messaging-app:abc:token'
  enabled: boolean;
  createdAt: string;
  globalDenyList: string[]; // blocked before any routing evaluates
  routing: RoutingRule[]; // ordered, first match wins
  metadata?: Record<string, string>; // platform-specific data, e.g. { username: 'mybot' }
}

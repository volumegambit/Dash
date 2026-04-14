export type GatewayEvent =
  | { type: 'agent:config-changed'; agent: string; fields: string[] }
  | { type: 'channel:created'; channel: string }
  | { type: 'channel:config-changed'; channel: string; fields: string[] }
  | { type: 'channel:removed'; channel: string }
  | { type: 'channel:restarted'; channel: string; reason: string }
  | { type: 'mcp:server-added'; server: string }
  | { type: 'mcp:server-removed'; server: string };

type Subscriber = (event: GatewayEvent) => void;

export class EventBus {
  private subscribers = new Set<Subscriber>();

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  emit(event: GatewayEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // Don't let one subscriber break others
      }
    }
  }
}

import type { MobileWsClientFrame, MobileWsServerFrame } from '@dash/mobile-contract';
import type { MobileRestClient } from './rest';

export type FrameHandler = (frame: MobileWsServerFrame) => void;

const WS_OPEN = 1;

/** Matches the relay's `APP_SUBPROTOCOL`/`CREDENTIAL_SUBPROTOCOL_PREFIX`
 * constants (`apps/relay/src/relay-server.ts`) exactly. */
const APP_SUBPROTOCOL = 'dash.v1';
const CREDENTIAL_SUBPROTOCOL_PREFIX = 'dash.relay-credential.';

function buildWsUrl(base: string, ticket: string): string {
  const url = new URL(base);
  url.searchParams.set('ticket', ticket);
  return url.toString();
}

/**
 * Ticketed chat WebSocket client. Tickets are single-use with a 30s TTL
 * (minted by `MobileRestClient.createWsTicket`), so `connect()` always fetches
 * a fresh one — never cache a ticket across calls.
 */
export class ChatSocket {
  private socket: WebSocket | null = null;
  private closeFired = false;

  constructor(
    private readonly wsBaseUrl: string,
    private readonly rest: MobileRestClient,
    private readonly onFrame: FrameHandler,
    private readonly onClose: (reason: 'error' | 'closed') => void,
    private readonly wsFactory: (url: string, protocols?: string[]) => WebSocket = (
      url,
      protocols,
    ) => new WebSocket(url, protocols),
    /** When set, the socket is opened offering `['dash.v1',
     * 'dash.relay-credential.<value>']` as WS subprotocols — the relay
     * validates and strips the credential entry before forwarding upstream
     * and echoes back `dash.v1` as selected. Native/LAN connections (no
     * relay hop) leave this unset and offer no subprotocols at all. */
    private readonly relayCredential?: string,
  ) {}

  async connect(): Promise<void> {
    // A prior connection is still live: detach it *before* awaiting the new
    // ticket. Its listeners guard on `isCurrent()` (identity against
    // `this.socket`), so nulling it out here means any of its late
    // events — this `.close()` call included — can never be misattributed to
    // the new connection via the shared `closeFired` latch reset below.
    const previous = this.socket;
    if (previous) {
      this.socket = null;
      previous.close();
    }

    const { ticket } = await this.rest.createWsTicket();
    const url = buildWsUrl(this.wsBaseUrl, ticket);
    const protocols = this.relayCredential
      ? [APP_SUBPROTOCOL, `${CREDENTIAL_SUBPROTOCOL_PREFIX}${this.relayCredential}`]
      : undefined;
    const socket = this.wsFactory(url, protocols);
    this.socket = socket;
    this.closeFired = false;
    const isCurrent = () => this.socket === socket;

    return new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        if (isCurrent()) resolve();
      });

      socket.addEventListener('message', (event) => {
        if (!isCurrent()) return;
        const raw = (event as MessageEvent).data;
        const text = typeof raw === 'string' ? raw : String(raw);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Never crash the transcript: drop malformed server frames, loudly.
          console.warn('ChatSocket: dropping malformed frame from server', text);
          return;
        }
        this.onFrame(parsed as MobileWsServerFrame);
      });

      socket.addEventListener('error', () => {
        if (!isCurrent()) return;
        this.fireClose('error');
        // No-op if `resolve` already fired for this promise (settlement is idempotent).
        reject(new Error('ChatSocket: connection error'));
      });

      socket.addEventListener('close', () => {
        if (!isCurrent()) return;
        this.fireClose('closed');
        // Covers the socket closing before `open` ever fired (no prior error);
        // also a no-op once already resolved.
        reject(new Error('ChatSocket: connection closed before it opened'));
      });
    });
  }

  send(frame: MobileWsClientFrame): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      throw new Error('ChatSocket: cannot send while the socket is not open');
    }
    this.socket.send(JSON.stringify(frame));
  }

  close(): void {
    this.socket?.close();
  }

  /** Returns true the first time it's called (per connection); false on any repeat. */
  private fireClose(reason: 'error' | 'closed'): boolean {
    if (this.closeFired) return false;
    this.closeFired = true;
    this.onClose(reason);
    return true;
  }
}

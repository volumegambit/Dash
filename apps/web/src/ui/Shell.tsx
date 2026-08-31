import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { StoreApi, UseBoundStore } from 'zustand';
import { ChatSocket } from '../api/chat-socket.js';
import { MobileRestClient } from '../api/rest.js';
import type { ControlPlaneClient, GatewayInfo } from '../auth/control-plane.js';
import type { CredentialStore, StoredCredential } from '../auth/credential-store.js';
import { createWebAppStore } from '../state/store.js';
import type { WebAppState } from '../state/store.js';
import { ChatView } from './ChatView.js';
import { ConversationList } from './ConversationList.js';
import { Devices } from './Devices.js';
import { GatewayPicker } from './GatewayPicker.js';

/**
 * The app's top-level view state. `'sign-in'` is included for completeness
 * with the rest of the plan (App.tsx owns that boundary via Clerk's
 * `SignedIn`/`SignedOut`, which is what actually gates mounting `Shell` at
 * all) — `Shell` itself only ever computes `'pick-gateway'` or `'chat'`.
 */
export type ShellView = 'sign-in' | 'pick-gateway' | 'chat';

type WebAppStore = UseBoundStore<StoreApi<WebAppState>>;

/** Exported so Task 13's own component tests (`ChatView.test.tsx`,
 * `ConversationList.test.tsx`) can wrap a component under test with a
 * scripted store without going through the full `Shell` mount. */
export const WebAppStoreContext = createContext<WebAppStore | null>(null);

/** Exact copy shown on `GatewayPicker` after `Shell` routes back to it
 * because the store's `connection` went to `'unauthorized'` — a remotely
 * revoked/rejected credential (design doc, Error Handling: "revoked/rejected
 * credential → GatewayPicker with explanation"). */
export const SESSION_REVOKED_COPY =
  'Your web session for this gateway was revoked. Pair again to continue.';

/** Reads the store `Shell` created for the picked gateway. Must be called
 * from a component mounted under `Shell`'s `'chat'` view (Task 13's
 * ConversationList/ChatView/Devices). */
export function useWebAppStore(): WebAppStore {
  const store = useContext(WebAppStoreContext);
  if (!store) {
    throw new Error('useWebAppStore must be used within Shell once a gateway has been chosen');
  }
  return store;
}

export interface ShellProps {
  controlPlaneClient: Pick<
    ControlPlaneClient,
    | 'listGateways'
    | 'createWebPairing'
    | 'claimCredential'
    | 'getPairingStatus'
    | 'listPairings'
    | 'deletePairing'
  >;
  credentialStore: Pick<CredentialStore, 'get' | 'set' | 'delete'>;
  /** Domain the relay is served under; combined with the gateway's
   * `subdomain` to build its REST/WS base URLs (see `gatewayBaseUrls`). Note
   * there is no Clerk-token prop here: once a gateway is picked, REST/WS auth
   * to it runs entirely on the gateway's own chat token and relay credential
   * (both from `credentialStore`) — Clerk only authenticates
   * `controlPlaneClient` calls, which App.tsx wires up before `Shell` ever
   * sees it. */
  relayDomain: string;
}

function gatewayBaseUrls(
  gateway: GatewayInfo,
  relayDomain: string,
): { restBaseUrl: string; wsBaseUrl: string } {
  // The control plane's `subdomain` field carries the FULL relay host
  // (e.g. `mygw.relay.example.com`), not just the label — appending
  // `relayDomain` again would double the zone. Use it verbatim when it is
  // already dotted, carrying over any explicit port from `relayDomain`.
  const portIndex = relayDomain.indexOf(':');
  const port = portIndex === -1 ? '' : relayDomain.slice(portIndex);
  const host = gateway.subdomain.includes('.')
    ? `${gateway.subdomain}${port}`
    : `${gateway.subdomain}.${relayDomain}`;
  return {
    restBaseUrl: `https://${host}/mobile/v1`,
    wsBaseUrl: `wss://${host}/ws/chat`,
  };
}

/**
 * App shell: on mount, lists the account's gateways and checks whether this
 * browser already holds a paired `StoredCredential` for any of them — if so
 * it skips straight to the `'chat'` view; otherwise it shows `GatewayPicker`.
 * Choosing a gateway there (`onReady`) transitions the same way a stored
 * credential would.
 *
 * The `'chat'` view creates the conversation store (`createWebAppStore`) and
 * a `ChatSocket`-backed `socketFactory` from the picked gateway's base URLs,
 * authenticating both with the gateway's own `chatToken` (as the mobile-v1
 * bearer) and `relayCredential` (as the relay hop's WS subprotocol / REST
 * header) — never the Clerk token, which the gateway doesn't understand —
 * and exposes it via `WebAppStoreContext` (see `useWebAppStore`) to
 * `ChatWorkspace`, which composes the actual chat surface
 * (`ConversationList`/`ChatView`/`Devices`).
 */
export function Shell({ controlPlaneClient, credentialStore, relayDomain }: ShellProps) {
  const [loading, setLoading] = useState(true);
  const [gateways, setGateways] = useState<GatewayInfo[]>([]);
  const [activeGateway, setActiveGateway] = useState<GatewayInfo | null>(null);
  const [activeCredential, setActiveCredential] = useState<StoredCredential | null>(null);
  /** Set when `handleUnauthorized` routes back to `GatewayPicker` after a
   * revoked/rejected credential; cleared once a gateway is (re-)picked. */
  const [pickGatewayNotice, setPickGatewayNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init(): Promise<void> {
      try {
        const list = await controlPlaneClient.listGateways();
        if (cancelled) return;
        setGateways(list);

        for (const gateway of list) {
          const stored = await credentialStore.get(gateway.gatewayId);
          if (cancelled) return;
          if (stored) {
            setActiveGateway(gateway);
            setActiveCredential(stored);
            break;
          }
        }
      } catch (err) {
        console.error('Shell: failed to load gateways', err);
        // Surface the real failure instead of masquerading as an empty
        // account — an unreachable control plane or a failed Clerk token
        // exchange must read differently from "no gateways enrolled".
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setPickGatewayNotice(`Couldn't load your gateways: ${message}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [controlPlaneClient, credentialStore]);

  const store = useMemo(() => {
    if (!activeGateway || !activeCredential) return null;
    const { restBaseUrl, wsBaseUrl } = gatewayBaseUrls(activeGateway, relayDomain);
    const { relayCredential, chatToken } = activeCredential;
    // The gateway's own mobile-v1 bearer — not the Clerk session token.
    const rest = new MobileRestClient(
      restBaseUrl,
      { getToken: () => Promise.resolve(chatToken) },
      undefined,
      relayCredential,
    );
    return createWebAppStore({
      rest,
      socketFactory: (onFrame, onClose) =>
        new ChatSocket(wsBaseUrl, rest, onFrame, onClose, undefined, relayCredential),
    });
  }, [activeGateway, activeCredential, relayDomain]);

  // The single teardown spot for whichever store is currently live: fires on
  // a real unmount, AND whenever `store` itself changes identity — i.e. this
  // browser picks/re-pairs a *different* gateway, or `handleGatewayForgotten`
  // nulls `activeGateway`/`activeCredential` (self-revocation), which makes
  // the `useMemo` above recompute `store` to `null`. Either way, the just-
  // abandoned store's `dispose()` closes its live socket and cancels any
  // pending reconnect timer/attempt rather than leaving it to retry (bounded,
  // but pointless) against a credential that's no longer valid.
  useEffect(() => {
    return () => {
      store?.getState().dispose();
    };
  }, [store]);

  /** Design doc, Error Handling: "revoked/rejected credential →
   * GatewayPicker with explanation. Never a silent retry loop on auth
   * failures." The store itself already stops reconnecting the moment its
   * `connection` reaches `'unauthorized'` (see `state/store.ts`
   * `enterUnauthorized`) — this effect is what notices that from the Shell
   * side and acts on it: the dead credential is no good to keep around, so
   * drop it, then clear `activeGateway`/`activeCredential`, which both
   * routes `view` back to `'pick-gateway'` and (via the teardown effect
   * above, once `store` recomputes to `null`) disposes the abandoned store.
   * Subscribes via the store's vanilla `subscribe`/`getState()` rather than
   * the React hook form since `Shell` itself sits *outside*
   * `WebAppStoreContext.Provider` — `useWebAppStore()` isn't available here. */
  useEffect(() => {
    if (!store || !activeGateway) return;
    const gatewayId = activeGateway.gatewayId;

    async function handleUnauthorized(): Promise<void> {
      try {
        await credentialStore.delete(gatewayId);
      } catch (err) {
        // The credential is dead server-side regardless of whether the
        // *local* copy was successfully cleared — never strand the user on
        // a chat view backed by a revoked session just because this step
        // failed.
        console.error('Shell: failed to clear the credential store after an auth failure', err);
      } finally {
        setPickGatewayNotice(SESSION_REVOKED_COPY);
        setActiveGateway(null);
        setActiveCredential(null);
      }
    }

    if (store.getState().connection === 'unauthorized') {
      void handleUnauthorized();
      return;
    }
    return store.subscribe((state) => {
      if (state.connection === 'unauthorized') void handleUnauthorized();
    });
  }, [store, activeGateway, credentialStore]);

  const view: ShellView = activeGateway && activeCredential && store ? 'chat' : 'pick-gateway';

  function handleReady(gateway: GatewayInfo, stored: StoredCredential): void {
    setPickGatewayNotice(null);
    setActiveGateway(gateway);
    setActiveCredential(stored);
  }

  /** Revoking this browser's own pairing from the Devices screen leaves the
   * stored credential dangling (the relay/gateway will reject it from here
   * on) — drop back to `GatewayPicker` so the user re-pairs rather than
   * sitting on a chat view that silently stops working. Disposing the store
   * itself is handled by the `useEffect` above, triggered by `store`
   * recomputing to `null` once `activeGateway`/`activeCredential` clear. */
  function handleGatewayForgotten(): void {
    setActiveGateway(null);
    setActiveCredential(null);
  }

  if (loading) return null;

  if (view === 'chat' && store && activeGateway && activeCredential) {
    return (
      <WebAppStoreContext.Provider value={store}>
        <ChatWorkspace
          gateway={activeGateway}
          currentPairingId={activeCredential.pairingId}
          controlPlaneClient={controlPlaneClient}
          credentialStore={credentialStore}
          onGatewayForgotten={handleGatewayForgotten}
        />
      </WebAppStoreContext.Provider>
    );
  }

  return (
    <div className="pick-gateway-page">
      {pickGatewayNotice && <p role="alert">{pickGatewayNotice}</p>}
      <GatewayPicker
        gateways={gateways}
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        onReady={handleReady}
      />
    </div>
  );
}

interface ChatWorkspaceProps {
  gateway: GatewayInfo;
  currentPairingId: string;
  controlPlaneClient: Pick<ControlPlaneClient, 'listPairings' | 'deletePairing'>;
  credentialStore: Pick<CredentialStore, 'delete'>;
  onGatewayForgotten: () => void;
}

/**
 * The `'chat'` view's own internal navigation — a conversations screen
 * (`ConversationList` + `ChatView`) and a `Devices` screen, switched locally
 * (no router in this app; see `AppRoot`/`App`, which only gate
 * signed-in/signed-out). `WebAppStoreContext` is already provided by the
 * caller (`Shell`), so `ConversationList`/`ChatView` reach the store via
 * `useWebAppStore()` same as any consumer mounted under `Shell`'s `'chat'`
 * view.
 *
 * Layout (chat-ux Phase 2 Task 1, audit #1): a 100dvh app-shell grid — a
 * topbar (gateway label + Conversations/Devices tabs + a hamburger that only
 * shows under 768px) over a sidebar/main body. The sidebar (`ConversationList`)
 * is a normal grid column at desktop width and an overlay drawer under
 * 768px, toggled by the hamburger (`aria-expanded`, closes on Escape or a
 * backdrop click, and on picking a conversation).
 */
function ChatWorkspace({
  gateway,
  currentPairingId,
  controlPlaneClient,
  credentialStore,
  onGatewayForgotten,
}: ChatWorkspaceProps) {
  const [screen, setScreen] = useState<'conversations' | 'devices'>('conversations');
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Escape closes the mobile drawer — a no-op (no listener attached) once
  // the drawer is already closed.
  useEffect(() => {
    if (!sidebarOpen) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setSidebarOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sidebarOpen]);

  function selectConversation(conversationId: string): void {
    setSelectedConversationId(conversationId);
    // Harmless when the drawer isn't open (desktop widths never set it true).
    setSidebarOpen(false);
  }

  // Conversation management (chat-ux Phase 3 Task 1, audit #8): the store's
  // own `deleteConversation` already removed the row from `conversations`
  // and (if it was the socket's currently-open conversation) torn down the
  // connection back to `'idle'` — but `selectedConversationId` is UI state
  // this component owns, not the store's. Clearing it here when the deleted
  // row was the one open drops `ChatView` back to its plain "Select a
  // conversation" empty state (`conversationId={null}`) instead of leaving
  // it pointed at a conversation that no longer exists.
  function handleConversationDeleted(conversationId: string): void {
    setSelectedConversationId((current) => (current === conversationId ? null : current));
  }

  return (
    <div data-testid="chat-workspace" className="app-shell">
      <div className="app-topbar">
        <button
          type="button"
          className="app-hamburger"
          aria-expanded={sidebarOpen}
          aria-label="Toggle conversations menu"
          onClick={() => setSidebarOpen((open) => !open)}
        >
          ☰
        </button>
        <strong className="app-topbar-title">{gateway.subdomain}</strong>
        <nav className="app-topbar-nav">
          <button
            type="button"
            onClick={() => setScreen('conversations')}
            aria-current={screen === 'conversations' ? 'page' : undefined}
          >
            Conversations
          </button>
          <button
            type="button"
            onClick={() => setScreen('devices')}
            aria-current={screen === 'devices' ? 'page' : undefined}
          >
            Devices
          </button>
        </nav>
      </div>
      <div className="app-body">
        {screen === 'devices' ? (
          <Devices
            gatewayId={gateway.gatewayId}
            currentPairingId={currentPairingId}
            controlPlaneClient={controlPlaneClient}
            credentialStore={credentialStore}
            onCurrentDeviceRevoked={onGatewayForgotten}
          />
        ) : (
          <>
            {sidebarOpen && (
              <button
                type="button"
                className="app-sidebar-backdrop"
                aria-label="Close conversations menu"
                onClick={() => setSidebarOpen(false)}
              />
            )}
            <aside className={`app-sidebar${sidebarOpen ? ' app-sidebar--open' : ''}`}>
              <ConversationList
                selectedConversationId={selectedConversationId}
                onSelect={selectConversation}
                onConversationDeleted={handleConversationDeleted}
              />
            </aside>
            <ChatView conversationId={selectedConversationId} gatewayLabel={gateway.subdomain} />
          </>
        )}
      </div>
    </div>
  );
}

export default Shell;

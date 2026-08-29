import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { StoreApi, UseBoundStore } from 'zustand';
import { ChatSocket } from '../api/chat-socket.js';
import { MobileRestClient } from '../api/rest.js';
import type { ControlPlaneClient, GatewayInfo } from '../auth/control-plane.js';
import type { CredentialStore, StoredCredential } from '../auth/credential-store.js';
import { createWebAppStore } from '../state/store.js';
import type { WebAppState } from '../state/store.js';
import { GatewayPicker } from './GatewayPicker.js';

/**
 * The app's top-level view state. `'sign-in'` is included for completeness
 * with the rest of the plan (App.tsx owns that boundary via Clerk's
 * `SignedIn`/`SignedOut`, which is what actually gates mounting `Shell` at
 * all) — `Shell` itself only ever computes `'pick-gateway'` or `'chat'`.
 */
export type ShellView = 'sign-in' | 'pick-gateway' | 'chat';

type WebAppStore = UseBoundStore<StoreApi<WebAppState>>;

const WebAppStoreContext = createContext<WebAppStore | null>(null);

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
  controlPlaneClient: Pick<ControlPlaneClient, 'listGateways' | 'createWebPairing'>;
  credentialStore: Pick<CredentialStore, 'get' | 'set'>;
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
  return {
    restBaseUrl: `https://${gateway.subdomain}.${relayDomain}/mobile/v1`,
    wsBaseUrl: `wss://${gateway.subdomain}.${relayDomain}/ws/chat`,
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
 * and exposes both via `WebAppStoreContext` (see `useWebAppStore`) so
 * Task 13's real chat surface can mount under it without Shell being
 * reworked. This task only renders a placeholder in that slot.
 */
export function Shell({ controlPlaneClient, credentialStore, relayDomain }: ShellProps) {
  const [loading, setLoading] = useState(true);
  const [gateways, setGateways] = useState<GatewayInfo[]>([]);
  const [activeGateway, setActiveGateway] = useState<GatewayInfo | null>(null);
  const [activeCredential, setActiveCredential] = useState<StoredCredential | null>(null);

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

  const view: ShellView = activeGateway && store ? 'chat' : 'pick-gateway';

  function handleReady(gateway: GatewayInfo, stored: StoredCredential): void {
    setActiveGateway(gateway);
    setActiveCredential(stored);
  }

  if (loading) return null;

  if (view === 'chat' && store) {
    return (
      <WebAppStoreContext.Provider value={store}>
        <div data-testid="chat-view-placeholder" />
      </WebAppStoreContext.Provider>
    );
  }

  return (
    <GatewayPicker
      gateways={gateways}
      controlPlaneClient={controlPlaneClient}
      credentialStore={credentialStore}
      onReady={handleReady}
    />
  );
}

export default Shell;

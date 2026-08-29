import { useState } from 'react';
import {
  ControlPlaneApiError,
  type ControlPlaneClient,
  type GatewayInfo,
} from '../auth/control-plane.js';
import type { CredentialStore, StoredCredential } from '../auth/credential-store.js';

/** Exact copy the brief mandates — points the user at Mission Control, since
 * gateways are enrolled there, not from the web client. */
export const GATEWAY_EMPTY_STATE_COPY =
  'No gateways linked to your account yet. Open Mission Control → Settings → Devices → Remote access to enroll this machine.';

/** Exact copy for the 409 the control plane returns when a gateway hasn't
 * registered a chat token yet (`ControlPlaneClient.createWebPairing`) — it
 * needs a fresh Mission Control enroll before browser pairing can work. */
export const GATEWAY_NEEDS_REENROLL_COPY =
  'This gateway needs to be re-enrolled from Mission Control before web access works.';

/** Coarse UA sniffing for a human-readable device label only (never used for
 * feature detection) — order matters: Edge/Opera UAs also contain "Chrome",
 * and Chrome UAs also contain "Safari", so the more specific tokens must be
 * checked first. */
function browserBrand(userAgent: string): string {
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/OPR\//.test(userAgent) || /Opera/.test(userAgent)) return 'Opera';
  if (/CriOS\//.test(userAgent) || /Chrome\//.test(userAgent) || /Chromium\//.test(userAgent)) {
    return 'Chrome';
  }
  if (/FxiOS\//.test(userAgent) || /Firefox\//.test(userAgent)) return 'Firefox';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return 'Browser';
}

/** Device label sent on `createWebPairing`, e.g. `'Web · Safari'`. */
export function buildWebDeviceLabel(userAgent: string): string {
  return `Web · ${browserBrand(userAgent)}`;
}

export interface GatewayPickerProps {
  gateways: GatewayInfo[];
  controlPlaneClient: Pick<ControlPlaneClient, 'createWebPairing'>;
  credentialStore: Pick<CredentialStore, 'set'>;
  onReady: (gateway: GatewayInfo, credential: StoredCredential) => void;
}

/**
 * Lists the account's gateways (by `subdomain` — `GatewayInfo` has no
 * `label`) and pairs this browser with whichever one the user picks: mints a
 * web-client credential, persists it, then hands off to `onReady`. Gateway
 * *enrollment* itself happens in Mission Control, not here — an empty list
 * just points the user there.
 */
export function GatewayPicker({
  gateways,
  controlPlaneClient,
  credentialStore,
  onReady,
}: GatewayPickerProps) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (gateways.length === 0) {
    return <p>{GATEWAY_EMPTY_STATE_COPY}</p>;
  }

  async function choose(gateway: GatewayInfo): Promise<void> {
    setError(null);
    setPendingId(gateway.gatewayId);
    try {
      const deviceLabel = buildWebDeviceLabel(navigator.userAgent);
      const { credential, chatToken } = await controlPlaneClient.createWebPairing(
        gateway.gatewayId,
        deviceLabel,
      );
      const stored: StoredCredential = { relayCredential: credential, chatToken };
      await credentialStore.set(gateway.gatewayId, stored);
      onReady(gateway, stored);
    } catch (err) {
      if (err instanceof ControlPlaneApiError && err.status === 409) {
        setError(GATEWAY_NEEDS_REENROLL_COPY);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to pair with this gateway.');
      }
      setPendingId(null);
    }
  }

  return (
    <div>
      <p>Choose a gateway to connect to.</p>
      <ul>
        {gateways.map((gateway) => (
          <li key={gateway.gatewayId}>
            <button
              type="button"
              onClick={() => void choose(gateway)}
              disabled={pendingId === gateway.gatewayId}
            >
              {gateway.subdomain}
            </button>
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export default GatewayPicker;

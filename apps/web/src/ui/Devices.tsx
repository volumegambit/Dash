import { useEffect, useState } from 'react';
import type { ControlPlaneClient, PairingInfo } from '../auth/control-plane.js';
import type { CredentialStore } from '../auth/credential-store.js';

export interface DevicesProps {
  gatewayId: string;
  /** This browser's own pairing id (`StoredCredential.pairingId`) — lets a
   * row be identified as "this device" so revoking it can also clear the
   * local credential and hand control back to `onCurrentDeviceRevoked`. */
  currentPairingId: string;
  controlPlaneClient: Pick<ControlPlaneClient, 'listPairings' | 'deletePairing'>;
  credentialStore: Pick<CredentialStore, 'delete'>;
  /** Called after the *current* browser's own pairing is revoked, once its
   * local credential has been cleared — the caller (`Shell`) uses this to
   * route back to `'pick-gateway'`, since the stored credential this browser
   * was using no longer works. */
  onCurrentDeviceRevoked: () => void;
}

/**
 * Lists the gateway's paired devices (`ControlPlaneClient.listPairings`) and
 * lets the user revoke any of them (`deletePairing`). Revoking the pairing
 * that matches `currentPairingId` — this browser's own — also clears the
 * local `CredentialStore` entry for this gateway and calls
 * `onCurrentDeviceRevoked`, since that stored credential is now dead.
 */
export function Devices({
  gatewayId,
  currentPairingId,
  controlPlaneClient,
  credentialStore,
  onCurrentDeviceRevoked,
}: DevicesProps) {
  const [pairings, setPairings] = useState<PairingInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const list = await controlPlaneClient.listPairings(gatewayId);
        if (!cancelled) setPairings(list);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load devices.');
          setPairings([]);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [gatewayId, controlPlaneClient]);

  async function revoke(pairingId: string): Promise<void> {
    setError(null);
    setRevokingId(pairingId);
    try {
      await controlPlaneClient.deletePairing(gatewayId, pairingId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke this device.');
      setRevokingId(null);
      return;
    }
    setPairings((prev) => (prev ?? []).filter((p) => p.id !== pairingId));
    setRevokingId(null);

    if (pairingId !== currentPairingId) return;
    try {
      await credentialStore.delete(gatewayId);
    } catch (err) {
      // The server-side pairing is dead either way (deletePairing above
      // already succeeded) — a failure to also clear the *local* credential
      // must not strand the user on a Devices screen backed by a pairing
      // that no longer exists, so `onCurrentDeviceRevoked` still fires below.
      console.error('Devices: failed to clear the local credential store', err);
    } finally {
      onCurrentDeviceRevoked();
    }
  }

  if (pairings === null) {
    return (
      <div className="app-devices-pane">
        <p>Loading devices…</p>
      </div>
    );
  }

  return (
    <div className="app-devices-pane">
      <h2>Devices</h2>
      {error && <p role="alert">{error}</p>}
      {pairings.length === 0 ? (
        <p>No paired devices.</p>
      ) : (
        <ul className="device-list">
          {pairings.map((pairing) => (
            <li key={pairing.id} data-testid="pairing-row" className="device-row">
              <span>{pairing.deviceLabel ?? 'Unnamed device'}</span>
              <span data-testid="pairing-client-kind">{pairing.clientKind}</span>
              {pairing.id === currentPairingId && <span>This device</span>}
              {/* A `'pending'` row (Task 4: signer-gated mint awaiting an iOS
                  signer's decision) isn't a real device yet — the control
                  plane's own DELETE route already treats it specially
                  (discards the pending row rather than revoking a live
                  credential), but a Revoke button here would still read as
                  "revoke this device" for something that was never paired. */}
              {pairing.status !== 'pending' && (
                <button
                  type="button"
                  onClick={() => void revoke(pairing.id)}
                  disabled={revokingId === pairing.id}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default Devices;

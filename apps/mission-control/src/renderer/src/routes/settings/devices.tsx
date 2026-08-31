import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { PairDeviceCard } from '../../components/PairDeviceCard.js';
import { type PairingStateChange, RelaySettings } from '../../components/RelaySettings.js';

export function DeviceSettings(): JSX.Element {
  // Re-mounting mints a durable relay credential. Do that only when enrollment
  // changes the pairing mode or the user revoked the exact credential currently
  // displayed in the QR; revoking a different device must leave this QR intact.
  const [pairingRefresh, setPairingRefresh] = useState(0);
  const [displayedPairingId, setDisplayedPairingId] = useState<string | null>(null);
  const refreshPairing = useCallback(() => {
    setDisplayedPairingId(null);
    setPairingRefresh((n) => n + 1);
  }, []);
  const onPairingStateChanged = useCallback(
    (change: PairingStateChange) => {
      if (change.type === 'enrolled' || change.deviceId === displayedPairingId) {
        refreshPairing();
      }
    },
    [displayedPairingId, refreshPairing],
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="bg-surface px-8 py-4 border-b border-border shrink-0">
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
          Devices
        </h1>
        <p className="mt-1 text-sm text-muted">
          Pair your phone and manage remote access to this gateway.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <PairDeviceCard key={pairingRefresh} onPairingIdChanged={setDisplayedPairingId} />
        <RelaySettings
          displayedPairingId={displayedPairingId}
          onPairingStateChanged={onPairingStateChanged}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/settings/devices')({
  component: DeviceSettings,
});

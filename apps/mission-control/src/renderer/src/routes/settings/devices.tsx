import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { PairDeviceCard } from '../../components/PairDeviceCard.js';
import { RelaySettings } from '../../components/RelaySettings.js';

export function DeviceSettings(): JSX.Element {
  // The pairing QR payload switches from pinned LAN (v3) to relay (v2) the moment a
  // gateway is enrolled, and both sections live on the same page — re-mount
  // the card on enrollment so it re-fetches instead of showing a stale LAN QR.
  const [pairingRefresh, setPairingRefresh] = useState(0);

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
        <PairDeviceCard key={pairingRefresh} />
        <RelaySettings onEnrolled={() => setPairingRefresh((n) => n + 1)} />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/settings/devices')({
  component: DeviceSettings,
});

import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { PairDeviceCard } from '../../components/PairDeviceCard.js';
import { RelaySettings } from '../../components/RelaySettings.js';

export function DeviceSettings(): JSX.Element {
  // The pairing QR payload switches from LAN (v1) to relay (v2) the moment a
  // gateway is enrolled, and both sections now live on the same tab — re-mount
  // the card on enrollment so it re-fetches instead of showing a stale LAN QR.
  const [pairingRefresh, setPairingRefresh] = useState(0);

  return (
    <>
      <PairDeviceCard key={pairingRefresh} />
      <RelaySettings onEnrolled={() => setPairingRefresh((n) => n + 1)} />
    </>
  );
}

export const Route = createFileRoute('/settings/devices')({
  component: DeviceSettings,
});

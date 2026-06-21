import { createFileRoute } from '@tanstack/react-router';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { PairingInfo } from '../../../shared/ipc.js';

/** Build the scannable QR payload from the pairing info (v1 LAN or v2 relay). */
function qrPayload(i: PairingInfo): string {
  if (i.mode === 'relay') {
    return JSON.stringify({
      v: 2,
      host: i.host,
      secure: i.secure,
      mgmtToken: i.mgmtToken,
      chatToken: i.chatToken,
      relayCredential: i.relayCredential,
    });
  }
  return JSON.stringify({
    v: 1,
    host: i.host,
    mgmtToken: i.mgmtToken,
    chatToken: i.chatToken,
    mgmtPort: i.mgmtPort,
    chatPort: i.chatPort,
  });
}

/**
 * Read-only screen that renders a QR code the Dash Android app scans to pair.
 * The QR encodes the gateway host + both tokens (and, over relay, the per-device
 * relay credential); secrets are never shown as plaintext on screen. The QR is
 * built as an SVG data URI (pure JS, no canvas) so it renders identically in
 * Electron and under test.
 */
export function PairDevice(): JSX.Element {
  const [info, setInfo] = useState<PairingInfo | null>(null);
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.api
      .pairingGetInfo()
      .then(async (i) => {
        setInfo(i);
        const svg = await QRCode.toString(qrPayload(i), { type: 'svg', margin: 1, width: 280 });
        setQrSrc(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load pairing info');
      });
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="bg-surface px-8 py-4 border-b border-border shrink-0">
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
          Pair Device
        </h1>
        <p className="mt-1 text-sm text-muted">
          Scan this code with the Dash Android app to connect over your local network.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        {error && <p className="text-red text-sm">{error}</p>}

        {qrSrc && (
          <img
            data-testid="pairing-qr"
            src={qrSrc}
            alt="Pairing QR code"
            width={280}
            height={280}
            className="rounded-lg bg-white p-3"
          />
        )}

        {info && (
          <p className="mt-4 text-sm text-foreground">
            Gateway:{' '}
            <span className="font-mono">
              {info.mode === 'lan' ? `${info.host}:${info.mgmtPort}` : info.host}
            </span>
            <span
              data-testid="pairing-mode"
              className="ml-2 rounded bg-surface px-2 py-0.5 text-xs text-muted"
            >
              {info.mode === 'relay' ? 'relay' : 'local network'}
            </span>
          </p>
        )}

        {info?.mode === 'relay' ? (
          <p className="mt-2 max-w-md text-xs text-muted">
            This code connects your phone over the internet through your relay. The connection
            tokens and a per-device relay credential are embedded in the QR code and are never
            displayed here.
          </p>
        ) : (
          <p className="mt-2 max-w-md text-xs text-muted">
            Your phone must be on the same Wi-Fi network. The connection tokens are embedded in the
            QR code and are never displayed here. To pair over the internet, set up a Dash relay.
          </p>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/pair-device')({
  component: PairDevice,
});

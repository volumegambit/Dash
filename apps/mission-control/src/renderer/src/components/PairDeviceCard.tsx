import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { PairingInfo } from '../../../shared/ipc.js';

/** Build the scannable QR payload from the pairing info (v3 LAN or v2 relay). */
export function qrPayload(i: PairingInfo): string {
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
    v: 3,
    host: i.host,
    secure: i.secure,
    mgmtToken: i.mgmtToken,
    chatToken: i.chatToken,
    mgmtPort: i.mgmtPort,
    chatPort: i.chatPort,
    tlsCertificateSha256: i.tlsCertificateSha256,
  });
}

/**
 * Read-only settings card that renders a QR code the Dash Android app scans to pair. (Dash for
 * iOS connects by signing in to a Dash account instead — see the account sign-in flow — so this
 * card no longer mentions it.) The QR encodes the gateway host, one phone-scoped mobile token,
 * and, over relay, the per-device relay credential; secrets are never shown as plaintext on
 * screen. The QR is built as an SVG data URI (pure JS, no canvas) so it renders identically in
 * Electron and under test.
 */
export function PairDeviceCard({
  onPairingIdChanged,
}: {
  onPairingIdChanged?: (pairingId: string | null) => void;
}): JSX.Element {
  const [info, setInfo] = useState<PairingInfo | null>(null);
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.api
      .pairingGetInfo()
      .then(async (i) => {
        const svg = await QRCode.toString(qrPayload(i), { type: 'svg', margin: 1, width: 280 });
        if (!alive) return;
        setInfo(i);
        setQrSrc(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
        onPairingIdChanged?.(i.mode === 'relay' ? i.pairingId : null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : 'Failed to load pairing info');
      });
    return () => {
      alive = false;
    };
  }, [onPairingIdChanged]);

  return (
    <div className="rounded-lg border border-border bg-card-bg p-4">
      <h2 className="mb-1 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
        Pair Device
      </h2>
      <p className="mb-4 text-xs text-muted">
        Scan this code with the Dash mobile app for Android.
      </p>

      {error && <p className="text-red text-sm">{error}</p>}

      {qrSrc && (
        <img
          data-testid="pairing-qr"
          src={qrSrc}
          alt="Pairing QR code for the Dash mobile app"
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
          This code connects your phone over the internet through your relay. The mobile token and a
          per-device relay credential are embedded in the QR code and are never displayed here.
        </p>
      ) : (
        <p className="mt-2 max-w-md text-xs text-muted">
          Your phone must be on the same Wi-Fi network. The mobile token and pinned gateway identity
          are embedded in the QR code and are never displayed here. To pair over the internet, set
          up remote access below.
        </p>
      )}
    </div>
  );
}

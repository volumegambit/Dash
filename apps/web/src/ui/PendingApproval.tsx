import { toDataURL } from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import type {
  ClaimCredentialResult,
  ControlPlaneClient,
  PairingInfo,
} from '../auth/control-plane.js';

/** Exact copy the design doc mandates for the waiting state (see
 * `docs/plans/2026-08-30-signer-device-design.md`, Component changes). */
export const WAITING_FOR_APPROVAL_COPY =
  'Waiting for approval — scan this code with the Dash app on your phone.';

/** Exact copy for both terminal, non-success states — the design doc gives a
 * single combined string ("declined/expired") rather than two distinct
 * messages: a denied approval and one this browser simply never heard back
 * from in time read identically to the person staring at the screen. */
export const APPROVAL_CLOSED_COPY = 'Approval declined/expired — try again.';

const POLL_INTERVAL_MS = 2_000;
const COUNTDOWN_TICK_MS = 1_000;

/** mm:ss, floored at 00:00 — never negative, never fractional. */
function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export interface ClaimedPendingCredential {
  credential: string;
  chatToken: string;
  pairingId: string;
}

export interface PendingApprovalProps {
  gatewayId: string;
  pairingId: string;
  approvalId: string;
  /** Unix milliseconds — from `WebPairingPending.approvalExpiresAt`. */
  approvalExpiresAt: number;
  controlPlaneClient: Pick<ControlPlaneClient, 'claimCredential' | 'getPairingStatus'>;
  /** Fired once, after a successful claim — the caller stores the credential
   * and proceeds exactly like the immediate-mint path. */
  onReady: (credential: ClaimedPendingCredential) => void;
  /** Fired when the user backs out, either voluntarily or after the approval
   * is declined/expired — routes back to the gateway list. */
  onBack: () => void;
}

type Phase = 'waiting' | 'declined' | 'expired' | 'claimed';

/**
 * Task 4: the screen a browser sees after `createWebPairing` returns
 * `status: 'pending'` (the account is signer-gated — see
 * `WebPairingPending`). Renders a `dash-approve:v1:<approvalId>` QR for an
 * iOS signer to scan, a live mm:ss countdown to `approvalExpiresAt`, and
 * polls `getPairingStatus` every 2s: once it reports `'active'`, claims the
 * single-use credential and hands it to `onReady`. The pairing disappearing
 * from the list (a signer denied it — the row is hard-deleted server-side,
 * never transitioned to a status) or the countdown reaching zero both land
 * on the same declined/expired copy, with a way back to the picker.
 */
export function PendingApproval({
  gatewayId,
  pairingId,
  approvalId,
  approvalExpiresAt,
  controlPlaneClient,
  onReady,
  onBack,
}: PendingApprovalProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(() => approvalExpiresAt - Date.now());
  const [phase, setPhase] = useState<Phase>('waiting');
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow-resolving claim overlapping the next poll tick —
  // `phase` itself flips synchronously only once the claim settles, so
  // without this a fast 2s tick during an in-flight claim could fire a
  // second one.
  const claimingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    toDataURL(`dash-approve:v1:${approvalId}`)
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render the approval QR code.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [approvalId]);

  // Countdown: independent of the poll loop, and stops updating once the
  // screen has left the 'waiting' phase (declined/expired/claimed).
  useEffect(() => {
    if (phase !== 'waiting') return;
    const tick = (): void => {
      const remaining = approvalExpiresAt - Date.now();
      setRemainingMs(remaining);
      if (remaining <= 0) setPhase('expired');
    };
    tick();
    const id = setInterval(tick, COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [approvalExpiresAt, phase]);

  // Poll loop: only runs while 'waiting' — the effect cleanup below clears
  // the interval the moment `phase` moves away from it (declined, expired,
  // or claimed), which is also what makes "claim called exactly once" hold
  // even if the parent doesn't unmount this component immediately on
  // `onReady`.
  useEffect(() => {
    if (phase !== 'waiting') return;
    let cancelled = false;

    async function pollOnce(): Promise<void> {
      if (cancelled || claimingRef.current) return;
      let status: PairingInfo['status'] | undefined;
      try {
        status = await controlPlaneClient.getPairingStatus(gatewayId, pairingId);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to check the approval status.');
        }
        return;
      }
      if (cancelled) return;

      if (status === undefined) {
        setPhase('declined');
        return;
      }
      if (status !== 'active') return;

      claimingRef.current = true;
      let result: ClaimCredentialResult;
      try {
        result = await controlPlaneClient.claimCredential(gatewayId, pairingId);
      } catch (err) {
        claimingRef.current = false;
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to claim the credential.');
        return;
      }
      claimingRef.current = false;
      if (cancelled) return;

      if (result.status === 'ok') {
        setPhase('claimed');
        onReady({ credential: result.credential, chatToken: result.chatToken, pairingId });
      } else if (result.status === 'gone') {
        setPhase('declined');
      }
      // result.status === 'pending' is a rare activation/claim race — the
      // next tick retries.
    }

    const id = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gatewayId, pairingId, controlPlaneClient, phase, onReady]);

  if (phase === 'declined' || phase === 'expired') {
    return (
      <div>
        <p>{APPROVAL_CLOSED_COPY}</p>
        <button type="button" onClick={onBack}>
          Back to gateways
        </button>
      </div>
    );
  }

  return (
    <div>
      <p>{WAITING_FOR_APPROVAL_COPY}</p>
      {qrDataUrl && <img src={qrDataUrl} alt="Approval code" />}
      <p data-testid="approval-countdown">{formatCountdown(remainingMs)}</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={onBack}>
        Back to gateways
      </button>
    </div>
  );
}

export default PendingApproval;

import { toDataURL } from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClaimCredentialResult,
  ControlPlaneClient,
  PairingInfo,
} from '../auth/control-plane.js';

/** Exact copy mandated by the plan's Global Constraints (the binding source —
 * supersedes the earlier design doc's combined "declined/expired" string). */
export const APPROVAL_HEADING = 'Approve this device';
export const WAITING_FOR_APPROVAL_COPY =
  'Waiting for approval — scan this code with the Dash app on your phone.';
export const APPROVAL_DECLINED_COPY = 'Approval declined. You can try again from the gateway list.';
export const APPROVAL_EXPIRED_COPY = 'The code expired. Try again from the gateway list.';

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

/** A single status-check-and-maybe-claim round. `'settled'` means `checkOnce`
 * itself already committed a phase transition (claimed, or a definitive
 * declined/expired from a disappeared/gone pairing) — the caller does
 * nothing further. `'not-active'` means the pairing is still pending (no
 * verdict yet) — safe to retry. `'busy'` means another `checkOnce` call was
 * already in flight (the shared guard below) — the caller should not draw
 * any conclusion, just try again shortly. */
type CheckOutcome = 'settled' | 'not-active' | 'busy';

/**
 * Task 4: the screen a browser sees after `createWebPairing` returns
 * `status: 'pending'` (the account is signer-gated — see
 * `WebPairingPending`). Renders a `dash-approve:v1:<approvalId>` QR for an
 * iOS signer to scan, a live mm:ss countdown to `approvalExpiresAt`, and
 * polls `getPairingStatus` every 2s: once it reports `'active'`, claims the
 * single-use credential and hands it to `onReady`. The pairing disappearing
 * from the list (a signer denied it — the row is hard-deleted server-side,
 * never transitioned to a status) or the countdown reaching zero (with one
 * final authoritative check first — see `checkOnce`) land on distinct
 * declined/expired copy, with a way back to the picker.
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
  // Shared across the poll loop AND the countdown's final check (see
  // `checkOnce`) — without a single cross-effect guard, a slow check
  // overlapping the next scheduled one (poll-vs-poll, or poll-vs-the
  // countdown's zero-crossing check) could call `claimCredential` twice for
  // the same pairing.
  const checkingRef = useRef(false);
  // Flips true on unmount (e.g. the user clicks Back, which the parent
  // responds to by unmounting this component). Review fix: an in-flight
  // `checkOnce` doesn't stop just because its *caller* effect cleaned up —
  // `checkOnce` itself must re-check this after every `await` and bail
  // before any further side effect (another network call, `setPhase`,
  // `onReady`), or a slow `getPairingStatus` resolving after Back was
  // clicked can still claim the credential and fire `onReady` against the
  // user's explicit choice to back out.
  const cancelledRef = useRef(false);
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

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

  /** A 410 from `claimCredential`, or the pairing vanishing from the list, is
   * ambiguous on its own — it covers a genuine denial AND a swept-expired
   * approval alike. Disambiguate locally by comparing against the same
   * deadline the countdown itself counts down to: if it's already passed,
   * this is an expiry; otherwise it's a denial. */
  const closedPhaseFor = useCallback(
    (now: number): 'declined' | 'expired' => (now >= approvalExpiresAt ? 'expired' : 'declined'),
    [approvalExpiresAt],
  );

  /** One status check, claiming immediately if it comes back `'active'`.
   * Used by both the 2s poll loop and the countdown's final check on hitting
   * zero, through the shared `checkingRef` guard — so however this ends up
   * getting called from two places at once, `claimCredential` still only
   * ever fires once per activation. */
  const checkOnce = useCallback(async (): Promise<CheckOutcome> => {
    if (checkingRef.current) return 'busy';
    checkingRef.current = true;
    try {
      let status: PairingInfo['status'] | undefined;
      try {
        status = await controlPlaneClient.getPairingStatus(gatewayId, pairingId);
      } catch (err) {
        if (!cancelledRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to check the approval status.');
        }
        return 'not-active';
      }
      // Mirror pollOnce's original after-every-await pattern: re-check
      // cancellation before acting on ANYTHING this await produced.
      if (cancelledRef.current) return 'not-active';

      if (status === undefined) {
        setPhase(closedPhaseFor(Date.now()));
        return 'settled';
      }
      if (status !== 'active') return 'not-active';

      // Bail before initiating the claim itself, not just before consuming
      // its result — Back means "don't claim this credential on my behalf".
      if (cancelledRef.current) return 'not-active';

      let result: ClaimCredentialResult;
      try {
        result = await controlPlaneClient.claimCredential(gatewayId, pairingId);
      } catch (err) {
        if (!cancelledRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to claim the credential.');
        }
        return 'not-active';
      }
      if (cancelledRef.current) return 'not-active';

      if (result.status === 'ok') {
        setPhase('claimed');
        onReady({ credential: result.credential, chatToken: result.chatToken, pairingId });
        return 'settled';
      }
      if (result.status === 'gone') {
        setPhase(closedPhaseFor(Date.now()));
        return 'settled';
      }
      // result.status === 'pending' — a rare activation/claim race.
      return 'not-active';
    } finally {
      checkingRef.current = false;
    }
  }, [gatewayId, pairingId, controlPlaneClient, onReady, closedPhaseFor]);

  // Countdown: independent of the poll loop, and stops updating once the
  // screen has left the 'waiting' phase (declined/expired/claimed). On
  // hitting zero, it does NOT declare 'expired' outright — an approval that
  // lands in the last couple of poll-interval seconds must still win. It
  // stops its own interval and runs exactly one authoritative `checkOnce`;
  // only if that comes back `'not-active'` does it commit to 'expired'.
  useEffect(() => {
    if (phase !== 'waiting') return;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let retryTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let finalCheckStarted = false;

    function clearTimers(): void {
      if (intervalId !== undefined) clearInterval(intervalId);
      if (retryTimeoutId !== undefined) clearTimeout(retryTimeoutId);
    }

    function runFinalCheck(): void {
      finalCheckStarted = true;
      clearTimers();
      void checkOnce().then((outcome) => {
        if (cancelled) return;
        if (outcome === 'not-active') {
          setPhase(closedPhaseFor(Date.now()));
        } else if (outcome === 'busy') {
          // The poll loop's own check was already mid-flight — its result
          // (claim/decline/retry) will land shortly on its own, but in case
          // it turns out to be a no-op retry, try the final check again
          // ourselves shortly rather than getting stuck on the waiting
          // screen forever.
          finalCheckStarted = false;
          retryTimeoutId = setTimeout(runFinalCheck, COUNTDOWN_TICK_MS);
        }
        // 'settled': checkOnce already committed a phase transition itself.
      });
    }

    function tick(): void {
      const remaining = approvalExpiresAt - Date.now();
      setRemainingMs(remaining);
      if (remaining > 0 || finalCheckStarted) return;
      runFinalCheck();
    }

    tick();
    if (!finalCheckStarted) intervalId = setInterval(tick, COUNTDOWN_TICK_MS);
    return () => {
      cancelled = true;
      clearTimers();
    };
  }, [approvalExpiresAt, phase, checkOnce, closedPhaseFor]);

  // Poll loop: a self-rescheduling `setTimeout` chain, not `setInterval` —
  // the next check is only ever scheduled after the current one fully
  // settles, so a slow `getPairingStatus`/`claimCredential` round (or a
  // burst of catch-up timers after the tab was throttled) can never overlap
  // with another one calling `claimCredential` a second time. Stops the
  // moment `phase` leaves `'waiting'` (declined, expired, or claimed).
  useEffect(() => {
    if (phase !== 'waiting') return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    function scheduleNext(): void {
      if (cancelled) return;
      timeoutId = setTimeout(() => {
        void tick();
      }, POLL_INTERVAL_MS);
    }

    async function tick(): Promise<void> {
      const outcome = await checkOnce();
      if (cancelled) return;
      if (outcome !== 'settled') scheduleNext();
    }

    scheduleNext();
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [phase, checkOnce]);

  return (
    <div className="pending-approval">
      <h2>{APPROVAL_HEADING}</h2>
      {phase === 'declined' && <p>{APPROVAL_DECLINED_COPY}</p>}
      {phase === 'expired' && <p>{APPROVAL_EXPIRED_COPY}</p>}
      {(phase === 'waiting' || phase === 'claimed') && (
        <>
          <p>{WAITING_FOR_APPROVAL_COPY}</p>
          {qrDataUrl && <img className="pending-approval-qr" src={qrDataUrl} alt="Approval code" />}
          <p data-testid="approval-countdown">{formatCountdown(remainingMs)}</p>
          {error && <p role="alert">{error}</p>}
        </>
      )}
      <button type="button" onClick={onBack}>
        Back to gateways
      </button>
    </div>
  );
}

export default PendingApproval;

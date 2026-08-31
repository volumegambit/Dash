import { act, render, screen } from '@testing-library/react';
import { toDataURL } from 'qrcode';
import {
  APPROVAL_DECLINED_COPY,
  APPROVAL_EXPIRED_COPY,
  APPROVAL_HEADING,
  PendingApproval,
  WAITING_FOR_APPROVAL_COPY,
} from './PendingApproval.js';

vi.mock('qrcode', () => ({
  toDataURL: vi.fn(async (text: string) => `data:image/png;base64,MOCK(${text})`),
}));

const NOW = 1_700_000_000_000;

/** Advances fake time and flushes both timer callbacks and any promise
 * continuations they trigger, wrapped in `act` so React commits the
 * resulting state updates before the caller asserts on the DOM — plain
 * `vi.advanceTimersByTimeAsync` alone leaves the last update unflushed. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderPending(
  overrides: {
    approvalExpiresAt?: number;
    getPairingStatus?: ReturnType<typeof vi.fn>;
    claimCredential?: ReturnType<typeof vi.fn>;
    onReady?: ReturnType<typeof vi.fn>;
    onBack?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const getPairingStatus = overrides.getPairingStatus ?? vi.fn(async () => 'pending' as const);
  const claimCredential = overrides.claimCredential ?? vi.fn();
  const onReady = overrides.onReady ?? vi.fn();
  const onBack = overrides.onBack ?? vi.fn();

  render(
    <PendingApproval
      gatewayId="gw-1"
      pairingId="p-1"
      approvalId="appr-1"
      approvalExpiresAt={overrides.approvalExpiresAt ?? NOW + 120_000}
      controlPlaneClient={{ getPairingStatus, claimCredential }}
      onReady={onReady}
      onBack={onBack}
    />,
  );

  return { getPairingStatus, claimCredential, onReady, onBack };
}

describe('PendingApproval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the heading, the QR payload (dash-approve:v1:<approvalId>), and the exact waiting copy', async () => {
    renderPending();

    expect(screen.getByRole('heading', { name: APPROVAL_HEADING })).toBeTruthy();
    expect(screen.getByText(WAITING_FOR_APPROVAL_COPY)).toBeTruthy();

    // The QR render is a microtask (mocked toDataURL), not a timer — flush it.
    await advance(0);

    expect(toDataURL).toHaveBeenCalledWith('dash-approve:v1:appr-1');
    const img = screen.getByAltText('Approval code') as HTMLImageElement;
    expect(img.src).toContain('MOCK(');
  });

  it('shows a mm:ss countdown counting down from approvalExpiresAt', async () => {
    renderPending({ approvalExpiresAt: NOW + 125_000 });
    expect(screen.getByTestId('approval-countdown').textContent).toBe('02:05');

    await advance(3_000);
    expect(screen.getByTestId('approval-countdown').textContent).toBe('02:02');
  });

  it('polls every 2s; once status flips to active it claims exactly once and calls onReady', async () => {
    const getPairingStatus = vi.fn(
      async () => 'pending' as 'pending' | 'active' | 'revoked' | undefined,
    );
    const claimCredential = vi.fn(async () => ({
      status: 'ok' as const,
      credential: 'relay-cred',
      chatToken: 'chat-tok',
    }));
    const onReady = vi.fn();

    renderPending({ getPairingStatus, claimCredential, onReady });

    await advance(2_000);
    expect(getPairingStatus).toHaveBeenCalledTimes(1);
    expect(getPairingStatus).toHaveBeenCalledWith('gw-1', 'p-1');
    expect(claimCredential).not.toHaveBeenCalled();

    getPairingStatus.mockImplementation(async () => 'active');
    await advance(2_000);

    expect(claimCredential).toHaveBeenCalledTimes(1);
    expect(claimCredential).toHaveBeenCalledWith('gw-1', 'p-1');
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith({
      credential: 'relay-cred',
      chatToken: 'chat-tok',
      pairingId: 'p-1',
    });

    // No further claim calls once the credential has been claimed.
    await advance(6_000);
    expect(claimCredential).toHaveBeenCalledTimes(1);
  });

  it('does not double-invoke claimCredential when a status check is slower than the poll interval', async () => {
    // getPairingStatus never resolves until the test tells it to — models a
    // slow request (or a burst of catch-up timers after tab throttling)
    // outliving one or more 2s poll intervals.
    let resolveStatus: (value: 'active') => void = () => {};
    const getPairingStatus = vi.fn(
      () =>
        new Promise<'active'>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const claimCredential = vi.fn(async () => ({
      status: 'ok' as const,
      credential: 'relay-cred',
      chatToken: 'chat-tok',
    }));
    const onReady = vi.fn();

    renderPending({ getPairingStatus, claimCredential, onReady });

    // First poll tick fires and starts awaiting getPairingStatus.
    await advance(2_000);
    expect(getPairingStatus).toHaveBeenCalledTimes(1);

    // Several more poll intervals' worth of fake time pass while that first
    // check is still in flight — the self-rescheduling chain must not start
    // a second check (and therefore can't call claimCredential twice).
    await advance(6_000);
    expect(getPairingStatus).toHaveBeenCalledTimes(1);
    expect(claimCredential).not.toHaveBeenCalled();

    // Now let the slow check resolve — exactly one claim should follow.
    resolveStatus('active');
    await advance(0);

    expect(claimCredential).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('does one final status check before committing to expired: activation exactly at the countdown deadline still reaches onReady', async () => {
    // The approval activates exactly as the countdown hits zero — the poll
    // loop's own next scheduled check isn't due until T+4s, so only the
    // countdown's own final check (triggered at T+3s, the deadline) can
    // catch this in time.
    const getPairingStatus = vi.fn(async () => (Date.now() >= NOW + 3_000 ? 'active' : 'pending'));
    const claimCredential = vi.fn(async () => ({
      status: 'ok' as const,
      credential: 'relay-cred',
      chatToken: 'chat-tok',
    }));
    const onReady = vi.fn();

    renderPending({ approvalExpiresAt: NOW + 3_000, getPairingStatus, claimCredential, onReady });

    // Poll's own check at T+2s still sees 'pending' (before the deadline).
    await advance(2_000);
    expect(claimCredential).not.toHaveBeenCalled();

    // The countdown reaches zero at T+3s, exactly when status flips.
    await advance(1_000);

    expect(claimCredential).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith({
      credential: 'relay-cred',
      chatToken: 'chat-tok',
      pairingId: 'p-1',
    });
    expect(screen.queryByText(APPROVAL_EXPIRED_COPY)).toBeNull();

    // No stray extra claim once settled.
    await advance(6_000);
    expect(claimCredential).toHaveBeenCalledTimes(1);
  });

  it('treats the pairing disappearing (denied, well before the deadline) as declined: shows declined copy, never claims', async () => {
    const getPairingStatus = vi.fn(async () => undefined);
    const claimCredential = vi.fn();
    const onBack = vi.fn();

    renderPending({ getPairingStatus, claimCredential, onBack });

    await advance(2_000);

    expect(screen.getByText(APPROVAL_DECLINED_COPY)).toBeTruthy();
    expect(claimCredential).not.toHaveBeenCalled();

    screen.getByRole('button', { name: /back/i }).click();
    expect(onBack).toHaveBeenCalled();
  });

  it("maps claimCredential's 410 (gone) to declined when the local deadline hasn't passed yet", async () => {
    const getPairingStatus = vi.fn(async () => 'active' as const);
    const claimCredential = vi.fn(async () => ({ status: 'gone' as const }));

    renderPending({ approvalExpiresAt: NOW + 120_000, getPairingStatus, claimCredential });

    await advance(2_000);

    expect(screen.getByText(APPROVAL_DECLINED_COPY)).toBeTruthy();
    expect(screen.queryByText(APPROVAL_EXPIRED_COPY)).toBeNull();
  });

  it("maps claimCredential's 410 (gone) to expired when the local deadline has already passed", async () => {
    const getPairingStatus = vi.fn(async () => 'active' as const);
    const claimCredential = vi.fn(async () => ({ status: 'gone' as const }));

    renderPending({ approvalExpiresAt: NOW + 1_000, getPairingStatus, claimCredential });

    await advance(2_000);

    expect(screen.getByText(APPROVAL_EXPIRED_COPY)).toBeTruthy();
    expect(screen.queryByText(APPROVAL_DECLINED_COPY)).toBeNull();
  });

  it('shows expired copy once the countdown reaches zero with no verdict from the server, and stops polling', async () => {
    const getPairingStatus = vi.fn(async () => 'pending' as const);
    renderPending({ approvalExpiresAt: NOW + 3_000, getPairingStatus });

    await advance(3_100);

    expect(screen.getByText(APPROVAL_EXPIRED_COPY)).toBeTruthy();
    const callsAtExpiry = getPairingStatus.mock.calls.length;

    await advance(10_000);
    expect(getPairingStatus.mock.calls.length).toBe(callsAtExpiry);
  });
});

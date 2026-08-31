import { act, render, screen } from '@testing-library/react';
import { toDataURL } from 'qrcode';
import {
  APPROVAL_CLOSED_COPY,
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

  it('renders the QR payload (dash-approve:v1:<approvalId>) and the exact waiting copy', async () => {
    renderPending();

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

  it('treats the pairing disappearing (denied) as declined: shows declined copy, never claims', async () => {
    const getPairingStatus = vi.fn(async () => undefined);
    const claimCredential = vi.fn();
    const onBack = vi.fn();

    renderPending({ getPairingStatus, claimCredential, onBack });

    await advance(2_000);

    expect(screen.getByText(APPROVAL_CLOSED_COPY)).toBeTruthy();
    expect(claimCredential).not.toHaveBeenCalled();

    screen.getByRole('button', { name: /back/i }).click();
    expect(onBack).toHaveBeenCalled();
  });

  it('shows expired copy once the countdown reaches zero, and stops polling', async () => {
    const getPairingStatus = vi.fn(async () => 'pending' as const);
    renderPending({ approvalExpiresAt: NOW + 3_000, getPairingStatus });

    await advance(3_100);

    expect(screen.getByText(APPROVAL_CLOSED_COPY)).toBeTruthy();
    const callsAtExpiry = getPairingStatus.mock.calls.length;

    await advance(10_000);
    expect(getPairingStatus.mock.calls.length).toBe(callsAtExpiry);
  });
});

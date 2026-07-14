import { describe, expect, it, vi } from 'vitest';
import { buildPairingInfo } from './pairing.js';

const lan = {
  host: '192.168.1.50',
  port: 9400,
  tlsCertificateSha256: 'a'.repeat(64),
};
const base = { mobileToken: 'mobile-tok', chatToken: 'c-tok', lan };

/**
 * Mirror of the renderer's `qrPayload` for relay mode (PairDeviceCard.tsx). Kept
 * here so the test asserts the exact v2 wire shape the Android app depends on —
 * if the relay payload drifts, this fails loudly. Do NOT change this shape.
 */
function relayQrPayload(i: {
  host: string;
  secure: true;
  mgmtToken: string;
  chatToken: string;
  relayCredential: string;
}): unknown {
  return {
    v: 2,
    host: i.host,
    secure: i.secure,
    mgmtToken: i.mgmtToken,
    chatToken: i.chatToken,
    relayCredential: i.relayCredential,
  };
}

describe('buildPairingInfo', () => {
  it('returns a LAN payload when no relay is configured', async () => {
    const provision = vi.fn();
    const info = await buildPairingInfo(base, provision);
    expect(info).toEqual({
      mode: 'lan',
      host: '192.168.1.50',
      secure: true,
      mgmtPort: 9400,
      chatPort: 9400,
      mgmtToken: 'mobile-tok',
      chatToken: 'c-tok',
      tlsCertificateSha256: 'a'.repeat(64),
    });
    expect(provision).not.toHaveBeenCalled();
  });

  it('provisions a credential through the control plane and returns a relay payload', async () => {
    const provision = vi.fn().mockResolvedValue('minted-cred');
    const info = await buildPairingInfo(
      { ...base, relay: { gatewayId: 'gw-1', host: 'relay.example.com' } },
      provision,
    );
    expect(info).toEqual({
      mode: 'relay',
      host: 'gw-1.relay.example.com',
      secure: true,
      mgmtToken: 'mobile-tok',
      chatToken: 'c-tok',
      relayCredential: 'minted-cred',
    });
    // Provisioned via the control plane with only the gateway id — MC never
    // holds the relay admin secret anymore.
    expect(provision).toHaveBeenCalledWith('gw-1');
  });

  it('produces the fixed v2 QR payload the Android app depends on', async () => {
    const provision = vi.fn().mockResolvedValue('minted-cred');
    const info = await buildPairingInfo(
      { ...base, relay: { gatewayId: 'gw-1', host: 'relay.example.com' } },
      provision,
    );
    if (info.mode !== 'relay') throw new Error('expected relay mode');
    expect(relayQrPayload(info)).toEqual({
      v: 2,
      host: 'gw-1.relay.example.com',
      secure: true,
      mgmtToken: 'mobile-tok',
      chatToken: 'c-tok',
      relayCredential: 'minted-cred',
    });
  });

  it('wraps a control-plane provision failure in a clear, actionable error', async () => {
    const provision = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      buildPairingInfo(
        { ...base, relay: { gatewayId: 'gw-1', host: 'relay.example.com' } },
        provision,
      ),
    ).rejects.toThrow(/Could not reach the relay.*ECONNREFUSED/);
  });

  it('falls back to LAN when relay config is incomplete', async () => {
    const provision = vi.fn();
    // Missing gatewayId → not fully configured.
    const info = await buildPairingInfo(
      { ...base, relay: { gatewayId: '', host: 'relay.example.com' } },
      provision,
    );
    expect(info.mode).toBe('lan');
    expect(provision).not.toHaveBeenCalled();
  });
});

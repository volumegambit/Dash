import { describe, expect, it, vi } from 'vitest';
import { buildPairingInfo } from './pairing.js';

const lan = { host: '192.168.1.50', mgmtPort: 9300, chatPort: 9200 };
const base = { mgmtToken: 'm-tok', chatToken: 'c-tok', lan };

describe('buildPairingInfo', () => {
  it('returns a LAN payload when no relay is configured', async () => {
    const provision = vi.fn();
    const info = await buildPairingInfo(base, provision);
    expect(info).toEqual({
      mode: 'lan',
      host: '192.168.1.50',
      mgmtPort: 9300,
      chatPort: 9200,
      mgmtToken: 'm-tok',
      chatToken: 'c-tok',
    });
    expect(provision).not.toHaveBeenCalled();
  });

  it('provisions a credential and returns a relay payload when fully configured', async () => {
    const provision = vi.fn().mockResolvedValue('minted-cred');
    const info = await buildPairingInfo(
      { ...base, relay: { zone: 'relay.example.com', gatewayId: 'gw-1', adminSecret: 'sek' } },
      provision,
    );
    expect(info).toEqual({
      mode: 'relay',
      host: 'gw-1.relay.example.com',
      secure: true,
      mgmtToken: 'm-tok',
      chatToken: 'c-tok',
      relayCredential: 'minted-cred',
    });
    // Provisioned against the gateway's own subdomain with the admin secret.
    expect(provision).toHaveBeenCalledWith('https://gw-1.relay.example.com', 'sek', 'gw-1');
  });

  it('wraps a relay provision failure in a clear, actionable error', async () => {
    const provision = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      buildPairingInfo(
        { ...base, relay: { zone: 'relay.example.com', gatewayId: 'gw-1', adminSecret: 'sek' } },
        provision,
      ),
    ).rejects.toThrow(/Could not reach the relay.*ECONNREFUSED/);
  });

  it('falls back to LAN when relay config is incomplete', async () => {
    const provision = vi.fn();
    // Missing adminSecret → not fully configured.
    const info = await buildPairingInfo(
      { ...base, relay: { zone: 'relay.example.com', gatewayId: 'gw-1', adminSecret: '' } },
      provision,
    );
    expect(info.mode).toBe('lan');
    expect(provision).not.toHaveBeenCalled();
  });
});

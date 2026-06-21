import type { PairingInfo } from '../shared/ipc.js';

/** Inputs the pairing builder needs, resolved by the IPC handler. */
export interface PairingInputs {
  mgmtToken: string;
  chatToken: string;
  lan: { host: string; mgmtPort: number; chatPort: number };
  /**
   * Relay config, present only when ALL three are set up (zone in settings,
   * gatewayId + admin secret in the keychain). Partial config falls back to LAN.
   */
  relay?: { zone: string; gatewayId: string; adminSecret: string };
}

/** Mints a per-device relay credential against the relay's admin API. */
export type Provisioner = (
  adminBaseUrl: string,
  adminSecret: string,
  gatewayId: string,
) => Promise<string>;

/**
 * Build the pairing payload. Relay mode is chosen only when relay config is
 * fully present; otherwise LAN. In relay mode the host is `<gatewayId>.<zone>`
 * (both HTTPS and WSS resolve there through the relay) and a fresh per-device
 * credential is provisioned — never reused — so revoking one device doesn't
 * affect others.
 */
export async function buildPairingInfo(
  inputs: PairingInputs,
  provision: Provisioner,
): Promise<PairingInfo> {
  const { relay } = inputs;
  if (relay?.zone && relay.gatewayId && relay.adminSecret) {
    const host = `${relay.gatewayId}.${relay.zone}`;
    const relayCredential = await provision(`https://${host}`, relay.adminSecret, relay.gatewayId);
    return {
      mode: 'relay',
      host,
      secure: true,
      mgmtToken: inputs.mgmtToken,
      chatToken: inputs.chatToken,
      relayCredential,
    };
  }
  return {
    mode: 'lan',
    host: inputs.lan.host,
    mgmtPort: inputs.lan.mgmtPort,
    chatPort: inputs.lan.chatPort,
    mgmtToken: inputs.mgmtToken,
    chatToken: inputs.chatToken,
  };
}

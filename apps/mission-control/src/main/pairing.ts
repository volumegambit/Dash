import type { PairingInfo } from '../shared/ipc.js';

/** Inputs the pairing builder needs, resolved by the IPC handler. */
export interface PairingInputs {
  mgmtToken: string;
  chatToken: string;
  lan: { host: string; mgmtPort: number; chatPort: number };
  /**
   * Hosted-relay config, present only when the gateway has been enrolled with
   * the control plane (a cached issued-gateway record with a `gatewayId` and the
   * relay base `host`). Absent/partial falls back to LAN pairing.
   */
  relay?: { gatewayId: string; host: string };
}

/**
 * Mints a per-device relay credential through the hosted control plane (which
 * calls the relay admin API server-side). MC only passes the gateway id — it
 * never holds the relay master secret.
 */
export type Provisioner = (gatewayId: string) => Promise<string>;

/**
 * Build the pairing payload. Relay mode is chosen only when the gateway is
 * enrolled (gatewayId + relay host present); otherwise LAN. In relay mode the
 * host is `<gatewayId>.<host>` (both HTTPS and WSS resolve there through the
 * relay) and a fresh per-device credential is provisioned via the control plane
 * — never reused — so revoking one device doesn't affect others.
 */
export async function buildPairingInfo(
  inputs: PairingInputs,
  provision: Provisioner,
): Promise<PairingInfo> {
  const { relay } = inputs;
  if (relay?.gatewayId && relay.host) {
    const host = `${relay.gatewayId}.${relay.host}`;
    let relayCredential: string;
    try {
      relayCredential = await provision(relay.gatewayId);
    } catch (err) {
      // Surface a clear, actionable reason rather than an opaque fetch error —
      // the Pair Device screen renders this message.
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not reach the relay to provision a pairing credential: ${reason}`);
    }
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

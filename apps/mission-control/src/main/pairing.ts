import type { PairingInfo } from '../shared/ipc.js';

interface PairingBaseInputs {
  /** Capability bearer accepted only by the gateway's `/mobile/v1` namespace. */
  mobileToken: string;
}

/** Inputs the pairing builder needs, resolved by the IPC handler. */
export type PairingInputs =
  | (PairingBaseInputs & {
      mode: 'relay';
      relay: { gatewayId: string; host: string };
    })
  | (PairingBaseInputs & {
      mode: 'lan';
      lan: { host: string; port: number; tlsCertificateSha256: string };
    });

/**
 * Mints a per-device relay credential through the hosted control plane (which
 * calls the relay admin API server-side). MC only passes the gateway id — it
 * never holds the relay master secret.
 */
export type Provisioner = (gatewayId: string) => Promise<{ credential: string; pairingId: string }>;

/**
 * Build the pairing payload. The IPC handler selects relay or LAN before
 * resolving mode-specific inputs. In relay mode the host is
 * `<gatewayId>.<host>` (both HTTPS and WSS resolve there through the relay) and
 * a fresh per-device credential is provisioned via the control plane — never
 * reused — so revoking one device doesn't affect others.
 */
export async function buildPairingInfo(
  inputs: PairingInputs,
  provision: Provisioner,
): Promise<PairingInfo> {
  if (inputs.mode === 'relay') {
    const { relay } = inputs;
    if (!relay.gatewayId || !relay.host) {
      throw new Error('Relay pairing requires an enrolled gateway and relay host');
    }
    const host = `${relay.gatewayId}.${relay.host}`;
    let relayCredential: string;
    let pairingId: string;
    try {
      const pairing = await provision(relay.gatewayId);
      relayCredential = pairing.credential;
      pairingId = pairing.pairingId;
    } catch (err) {
      // Surface a clear, actionable reason rather than an opaque fetch error —
      // the Pair Device card (Settings → Devices) renders this message.
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not reach the relay to provision a pairing credential: ${reason}`);
    }
    return {
      mode: 'relay',
      host,
      secure: true,
      mgmtToken: inputs.mobileToken,
      chatToken: inputs.mobileToken,
      relayCredential,
      pairingId,
    };
  }
  return {
    mode: 'lan',
    host: inputs.lan.host,
    secure: true,
    mgmtPort: inputs.lan.port,
    chatPort: inputs.lan.port,
    mgmtToken: inputs.mobileToken,
    chatToken: inputs.mobileToken,
    tlsCertificateSha256: inputs.lan.tlsCertificateSha256,
  };
}

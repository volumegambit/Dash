/**
 * Client for the relay's pairing-credential admin API.
 *
 * Mission Control calls this to provision a per-device credential at pair time
 * and revoke it on un-pair. The base URL is any address that resolves to the
 * relay (Caddy routes `*.<zone>`, and `/admin/*` is matched by path regardless
 * of Host); the secret is the relay's admin master secret, kept in the keychain.
 */
export interface RelayAdminClient {
  provisionCredential(gatewayId: string): Promise<string>;
  revokeCredential(gatewayId: string, credential: string): Promise<void>;
}

export function createRelayAdminClient(
  adminBaseUrl: string,
  adminSecret: string,
): RelayAdminClient {
  const base = adminBaseUrl.replace(/\/+$/, '');
  const headers = {
    authorization: `Bearer ${adminSecret}`,
    'content-type': 'application/json',
  };

  return {
    async provisionCredential(gatewayId: string): Promise<string> {
      const res = await fetch(`${base}/admin/pairings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ gatewayId }),
      });
      if (!res.ok) {
        throw new Error(`Relay admin: provision failed (HTTP ${res.status})`);
      }
      const body = (await res.json()) as { credential?: unknown };
      if (typeof body.credential !== 'string' || body.credential.length === 0) {
        throw new Error('Relay admin: provision returned no credential');
      }
      return body.credential;
    },

    async revokeCredential(gatewayId: string, credential: string): Promise<void> {
      const res = await fetch(`${base}/admin/pairings/revoke`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ gatewayId, credential }),
      });
      if (!res.ok) {
        throw new Error(`Relay admin: revoke failed (HTTP ${res.status})`);
      }
    },
  };
}

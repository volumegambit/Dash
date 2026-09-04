/**
 * Gateway port resolution for the Mission Control launch path.
 *
 * MC launches its gateway on fixed ports by default (9300 management,
 * 9200 channel), which makes two MC instances on one machine collide —
 * the second launch fails with "Port 9300 is already in use by another
 * gateway". QA runs and secondary profiles override the ports via
 * `MC_GATEWAY_MANAGEMENT_PORT` / `MC_GATEWAY_CHANNEL_PORT`.
 *
 * Invalid values throw rather than falling back: a typo that silently
 * landed back on 9300 would recreate exactly the collision the override
 * exists to prevent.
 */

export const DEFAULT_MANAGEMENT_PORT = 9300;
export const DEFAULT_CHANNEL_PORT = 9200;
export const DEFAULT_LAN_PORT = 9400;

export interface GatewayPorts {
  managementPort: number;
  channelPort: number;
  lanPort: number;
}

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got "${raw}"`);
  }
  return value;
}

export function resolveGatewayPorts(
  env: Record<string, string | undefined> = process.env,
): GatewayPorts {
  const managementPort = parsePort(
    env.MC_GATEWAY_MANAGEMENT_PORT,
    DEFAULT_MANAGEMENT_PORT,
    'MC_GATEWAY_MANAGEMENT_PORT',
  );
  const channelPort = parsePort(
    env.MC_GATEWAY_CHANNEL_PORT,
    DEFAULT_CHANNEL_PORT,
    'MC_GATEWAY_CHANNEL_PORT',
  );
  const lanPort = parsePort(env.MC_GATEWAY_LAN_PORT, DEFAULT_LAN_PORT, 'MC_GATEWAY_LAN_PORT');
  if (new Set([managementPort, channelPort, lanPort]).size !== 3) {
    throw new Error(
      'MC_GATEWAY_MANAGEMENT_PORT, MC_GATEWAY_CHANNEL_PORT, and MC_GATEWAY_LAN_PORT must differ',
    );
  }
  return { managementPort, channelPort, lanPort };
}

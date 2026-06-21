import { randomBytes } from 'node:crypto';

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Generate a stable per-gateway id for relay routing. The relay addresses a
 * gateway as `<gatewayId>.<zone>`, so the id must be a valid DNS subdomain
 * label: lowercase alphanumeric + hyphens, ≤63 chars. Hex (not base64url, which
 * uses `_`) keeps it DNS-safe; the `gw-` prefix makes it recognizable in logs.
 */
export function generateGatewayId(): string {
  return `gw-${randomBytes(8).toString('hex')}`;
}

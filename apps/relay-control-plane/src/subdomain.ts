/**
 * Words a gateway subdomain label may not claim — they collide with relay
 * infrastructure hostnames or are otherwise reserved. The label IS the gatewayId
 * (the relay routes by `<label>.<zone>`), so a reserved label must never be
 * provisioned.
 */
const RESERVED = new Set([
  'www',
  'api',
  'admin',
  'relay',
  'health',
  'gw',
  'mc',
  'app',
  'control',
  'status',
]);

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * True iff `label` is a DNS-safe, non-reserved subdomain label: lowercase
 * `[a-z0-9-]`, 1..63 chars, no leading or trailing hyphen. The regex's optional
 * tail enforces both the length bound and the no-edge-hyphen rule; the single
 * `[a-z0-9]` alternative admits a one-char label.
 */
export function validateSubdomainLabel(label: string): boolean {
  return LABEL.test(label) && !RESERVED.has(label);
}

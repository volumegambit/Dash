/** Resolved control-plane configuration. */
export interface ControlPlaneConfig {
  /** TCP port to listen on. */
  port: number;
  /** Path to the SQLite store (accounts → gateways → pairings). */
  dbPath: string;
  /** Base URL of the relay's admin API (the control plane is its sole caller). */
  relayAdminUrl: string;
  /** Master Bearer secret for the relay admin API. Required. */
  relayAdminSecret: string;
  /** DNS zone gateway subdomains are minted under (`<gatewayId>.<relayZone>`). */
  relayZone: string;
  /** TTL, in seconds, of the dial tokens this control plane signs. */
  dialTokenTtlSec: number;
  /**
   * Path to the PEM-encoded Ed25519 private key used to sign dial tokens. The
   * relay verifies these with the matching public key. Required.
   */
  dialTokenPrivateKeyPath: string;
  /**
   * Clerk OIDC credentials. Present only when both keys are supplied. Verifying
   * the ID token needs only the public Frontend API JWKS, so no secret key.
   */
  clerk?: { frontendApi: string; clientId: string };
}

/** A subset of {@link ControlPlaneConfig} parsed from CLI flags. */
export interface ControlPlaneFlags {
  port?: number;
  dbPath?: string;
  relayAdminUrl?: string;
  relayAdminSecret?: string;
  relayZone?: string;
  dialTokenTtlSec?: number;
  dialTokenPrivateKeyPath?: string;
}

export interface ControlPlaneConfigSources {
  argv?: string[];
  env?: Record<string, string | undefined>;
}

const DEFAULT_PORT = 9400;
const DEFAULT_DB_PATH = 'control-plane.db';
const DEFAULT_RELAY_ADMIN_URL = 'http://127.0.0.1:8443';
const DEFAULT_RELAY_ZONE = 'relay.local';
const DEFAULT_DIAL_TOKEN_TTL_SEC = 86400;

export function parseControlPlaneFlags(argv: string[]): ControlPlaneFlags {
  const flags: ControlPlaneFlags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      flags.port = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--db-path' && argv[i + 1]) {
      flags.dbPath = argv[i + 1];
      i++;
    } else if (argv[i] === '--relay-admin-url' && argv[i + 1]) {
      flags.relayAdminUrl = argv[i + 1];
      i++;
    } else if (argv[i] === '--relay-admin-secret' && argv[i + 1]) {
      flags.relayAdminSecret = argv[i + 1];
      i++;
    } else if (argv[i] === '--relay-zone' && argv[i + 1]) {
      flags.relayZone = argv[i + 1];
      i++;
    } else if (argv[i] === '--dial-token-ttl' && argv[i + 1]) {
      flags.dialTokenTtlSec = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--dial-token-private-key' && argv[i + 1]) {
      flags.dialTokenPrivateKeyPath = argv[i + 1];
      i++;
    }
  }
  return flags;
}

/**
 * Resolve config from CLI flags then environment then defaults (in that order
 * of precedence). The relay admin secret and the dial-token private key are
 * mandatory — without the secret the control plane cannot provision against the
 * relay, and without the private key it cannot sign dial tokens — so a missing
 * value is a hard error.
 */
export function loadConfig(sources: ControlPlaneConfigSources = {}): ControlPlaneConfig {
  const flags = parseControlPlaneFlags(sources.argv ?? []);
  const env = sources.env ?? {};

  const port = flags.port ?? (env.RELAY_CP_PORT ? Number(env.RELAY_CP_PORT) : DEFAULT_PORT);
  const dbPath = flags.dbPath ?? env.RELAY_CP_DB_PATH ?? DEFAULT_DB_PATH;
  const relayAdminUrl =
    flags.relayAdminUrl ?? env.RELAY_CP_RELAY_ADMIN_URL ?? DEFAULT_RELAY_ADMIN_URL;
  const relayAdminSecret = flags.relayAdminSecret ?? env.RELAY_CP_RELAY_ADMIN_SECRET ?? '';
  const relayZone = flags.relayZone ?? env.RELAY_CP_RELAY_ZONE ?? DEFAULT_RELAY_ZONE;
  const dialTokenTtlSec =
    flags.dialTokenTtlSec ??
    (env.RELAY_CP_DIAL_TOKEN_TTL
      ? Number(env.RELAY_CP_DIAL_TOKEN_TTL)
      : DEFAULT_DIAL_TOKEN_TTL_SEC);
  const dialTokenPrivateKeyPath =
    flags.dialTokenPrivateKeyPath ?? env.RELAY_CP_DIAL_TOKEN_PRIVATE_KEY ?? '';

  if (!relayAdminSecret) {
    throw new Error(
      'Relay admin secret required: pass --relay-admin-secret <secret> or set RELAY_CP_RELAY_ADMIN_SECRET',
    );
  }
  if (!dialTokenPrivateKeyPath) {
    throw new Error(
      'Dial-token private key required: pass --dial-token-private-key <path> or set RELAY_CP_DIAL_TOKEN_PRIVATE_KEY',
    );
  }

  const frontendApi = env.RELAY_CP_CLERK_FRONTEND_API;
  const clientId = env.RELAY_CP_CLERK_CLIENT_ID;
  const clerk = frontendApi && clientId ? { frontendApi, clientId } : undefined;

  return {
    port,
    dbPath,
    relayAdminUrl,
    relayAdminSecret,
    relayZone,
    dialTokenTtlSec,
    dialTokenPrivateKeyPath,
    clerk,
  };
}

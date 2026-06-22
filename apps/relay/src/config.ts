/** Resolved relay server configuration. */
export interface RelayConfig {
  /** TCP port to listen on. */
  port: number;
  /** Bind address. Defaults to loopback — the relay is meant to sit behind a
   *  TLS terminator (Caddy) that proxies to it; pass `--host 0.0.0.0` to expose
   *  it directly. */
  host: string;
  /** Shared admission secret a gateway must present on dial-in. */
  relayToken: string;
  /**
   * Master secret for the admin API (pairing-credential lifecycle). When set,
   * the relay validates real per-pairing credentials and exposes /admin/*; when
   * absent, pairing credentials are accepted permissively (dev mode).
   */
  adminSecret?: string;
  /**
   * Path to the PEM-encoded Ed25519 public key used to verify control-plane
   * signed dial tokens. When set, the relay runs in hosted (multi-tenant) mode:
   * gateways dial in with a signed, gatewayId-bound token instead of the shared
   * relay token, and pairings are kept in a durable store.
   */
  dialTokenPublicKeyPath?: string;
  /**
   * Path to the durable credential store (SQLite). Used in hosted mode; defaults
   * are resolved in main.ts when omitted.
   */
  storePath?: string;
}

/** A subset of {@link RelayConfig} parsed from CLI flags. */
export interface RelayFlags {
  port?: number;
  host?: string;
  relayToken?: string;
  adminSecret?: string;
  dialTokenPublicKeyPath?: string;
  storePath?: string;
}

export interface RelayConfigSources {
  argv?: string[];
  env?: Record<string, string | undefined>;
}

const DEFAULT_PORT = 8443;
const DEFAULT_HOST = '127.0.0.1';

export function parseRelayFlags(argv: string[]): RelayFlags {
  const flags: RelayFlags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      flags.port = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--host' && argv[i + 1]) {
      flags.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--relay-token' && argv[i + 1]) {
      flags.relayToken = argv[i + 1];
      i++;
    } else if (argv[i] === '--admin-secret' && argv[i + 1]) {
      flags.adminSecret = argv[i + 1];
      i++;
    } else if (argv[i] === '--dial-token-public-key' && argv[i + 1]) {
      flags.dialTokenPublicKeyPath = argv[i + 1];
      i++;
    } else if (argv[i] === '--store-path' && argv[i + 1]) {
      flags.storePath = argv[i + 1];
      i++;
    }
  }
  return flags;
}

/**
 * Resolve config from CLI flags then environment then defaults (in that order
 * of precedence). The relay token is mandatory in self-hosted mode — without it
 * any gateway could register — so a missing token is a hard error. In hosted
 * mode (a dial-token public key is supplied) gateways authenticate with signed,
 * gatewayId-bound tokens instead, so the shared relay token is not required.
 */
export function loadRelayConfig(sources: RelayConfigSources = {}): RelayConfig {
  const flags = parseRelayFlags(sources.argv ?? []);
  const env = sources.env ?? {};

  const port = flags.port ?? (env.RELAY_PORT ? Number(env.RELAY_PORT) : DEFAULT_PORT);
  const host = flags.host ?? env.RELAY_HOST ?? DEFAULT_HOST;
  const relayToken = flags.relayToken ?? env.RELAY_TOKEN ?? '';
  const adminSecret = flags.adminSecret ?? env.RELAY_ADMIN_SECRET ?? undefined;
  const dialTokenPublicKeyPath =
    flags.dialTokenPublicKeyPath ?? env.RELAY_DIAL_TOKEN_PUBLIC_KEY ?? undefined;
  const storePath = flags.storePath ?? env.RELAY_STORE_PATH ?? undefined;

  if (!relayToken && !dialTokenPublicKeyPath) {
    throw new Error('Relay token required: pass --relay-token <token> or set RELAY_TOKEN');
  }

  return { port, host, relayToken, adminSecret, dialTokenPublicKeyPath, storePath };
}

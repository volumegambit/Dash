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
}

/** A subset of {@link RelayConfig} parsed from CLI flags. */
export interface RelayFlags {
  port?: number;
  host?: string;
  relayToken?: string;
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
    }
  }
  return flags;
}

/**
 * Resolve config from CLI flags then environment then defaults (in that order
 * of precedence). The relay token is mandatory — without it any gateway could
 * register — so a missing token is a hard error rather than a silent default.
 */
export function loadRelayConfig(sources: RelayConfigSources = {}): RelayConfig {
  const flags = parseRelayFlags(sources.argv ?? []);
  const env = sources.env ?? {};

  const port = flags.port ?? (env.RELAY_PORT ? Number(env.RELAY_PORT) : DEFAULT_PORT);
  const host = flags.host ?? env.RELAY_HOST ?? DEFAULT_HOST;
  const relayToken = flags.relayToken ?? env.RELAY_TOKEN ?? '';

  if (!relayToken) {
    throw new Error('Relay token required: pass --relay-token <token> or set RELAY_TOKEN');
  }

  return { port, host, relayToken };
}

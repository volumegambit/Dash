export interface LoadConfigOptions {
  managementPort?: number;
  channelPort?: number;
  /** HTTPS/WSS mobile-only LAN surface. */
  lanPort?: number;
  token?: string;
  chatToken?: string;
  dataDir?: string;
  verbose?: boolean;
  /** Relay base URL (e.g. `wss://relay.example.com`). Enables relay mode when
   *  set together with relayToken. The gateway dials OUT to this URL. */
  relayUrl?: string;
  /** Bearer presented to the relay on dial-in (admission secret). */
  relayToken?: string;
  /** Stable per-gateway id; the relay addresses streams to `/gw/<gatewayId>`.
   *  Defaults to a value derived at startup when relay mode is on but unset. */
  gatewayId?: string;
  /** Control-plane base URL (e.g. `https://cp.example.com`). When set in relay
   *  mode, the gateway refreshes its own dial token via POST /gw/dial-token. */
  controlPlaneUrl?: string;
  /** Browser origins allowed to call the `/mobile/v1` surface cross-origin
   *  (exact match only). Empty/unset disables CORS on that surface entirely. */
  webOrigins?: string[];
}

/**
 * Gateway-wide swarm defaults. `maxConcurrentWorkersGlobal` is the hard ceiling
 * across ALL agents' runs on this gateway; `defaults` are the per-agent caps
 * used when an agent's own `swarm` block leaves a field unset.
 */
export interface GatewaySwarmDefaults {
  maxConcurrentWorkers: number;
  maxWorkersPerRun: number;
  maxSteersPerWorker: number;
  maxRunSeconds: number;
}

export interface GatewaySwarmConfig {
  maxConcurrentWorkersGlobal: number;
  defaults: GatewaySwarmDefaults;
}

/**
 * Built-in gateway swarm defaults. Overridden by user/env config via
 * {@link resolveSwarmConfig} (deep-merge: nested `defaults` fields fill
 * individually, everything else replaces).
 */
export const DEFAULT_SWARM_CONFIG: GatewaySwarmConfig = {
  maxConcurrentWorkersGlobal: 16,
  defaults: {
    maxConcurrentWorkers: 8,
    maxWorkersPerRun: 24,
    maxSteersPerWorker: 10,
    maxRunSeconds: 1800,
  },
};

/**
 * Deep-merge a partial swarm config over {@link DEFAULT_SWARM_CONFIG}: a
 * top-level `maxConcurrentWorkersGlobal` override wins, and each `defaults`
 * field is filled individually so a caller can override just one cap without
 * clobbering the rest. Returns a fresh object; never mutates the defaults.
 */
export function resolveSwarmConfig(
  overrides?: Partial<{
    maxConcurrentWorkersGlobal: number;
    defaults: Partial<GatewaySwarmDefaults>;
  }>,
): GatewaySwarmConfig {
  return {
    maxConcurrentWorkersGlobal:
      overrides?.maxConcurrentWorkersGlobal ?? DEFAULT_SWARM_CONFIG.maxConcurrentWorkersGlobal,
    defaults: {
      ...DEFAULT_SWARM_CONFIG.defaults,
      ...overrides?.defaults,
    },
  };
}

/** Partial swarm config accepted by {@link resolveSwarmConfig}. */
export type SwarmConfigOverrides = Partial<{
  maxConcurrentWorkersGlobal: number;
  defaults: Partial<GatewaySwarmDefaults>;
}>;

/**
 * Relay traffic reaches the gateway's loopback servers through the outbound
 * tunnel, so both inner servers must require their own credentials. Two
 * nonblank local credentials also enable the LAN listener, where the mobile
 * bearer must never collapse into the administrative scope. Tokenless or
 * partially configured local mode keeps its historical loopback-only behavior.
 */
export function validateGatewayStartupOptions(options: LoadConfigOptions): void {
  const managementToken = options.token?.trim();
  const mobileToken = options.chatToken?.trim();
  if (managementToken && mobileToken && managementToken === mobileToken) {
    throw new Error('Management and mobile/chat tokens must be distinct when both are configured');
  }
  if (options.relayUrl !== undefined && (!managementToken || !mobileToken)) {
    throw new Error(
      'Relay mode requires non-empty --token and --chat-token values to secure the management and chat servers',
    );
  }
}

const SWARM_ENV_VARS = [
  ['SWARM_MAX_CONCURRENT_WORKERS_GLOBAL', 'maxConcurrentWorkersGlobal', null],
  ['SWARM_DEFAULT_MAX_CONCURRENT_WORKERS', 'maxConcurrentWorkers', 'defaults'],
  ['SWARM_DEFAULT_MAX_WORKERS_PER_RUN', 'maxWorkersPerRun', 'defaults'],
  ['SWARM_DEFAULT_MAX_STEERS_PER_WORKER', 'maxSteersPerWorker', 'defaults'],
  ['SWARM_DEFAULT_MAX_RUN_SECONDS', 'maxRunSeconds', 'defaults'],
] as const;

/**
 * Read gateway swarm cap overrides from environment variables. Each variable
 * must be a positive integer; anything else is skipped and reported in
 * `warnings` (for the caller to log) so a typo'd cap never silently NaNs the
 * coordinator or gets dropped without a trace. Unset and empty-string
 * variables are simply absent from the result, letting
 * {@link resolveSwarmConfig} fill them from {@link DEFAULT_SWARM_CONFIG}.
 */
export function swarmOverridesFromEnv(env: Record<string, string | undefined> = process.env): {
  overrides: SwarmConfigOverrides;
  warnings: string[];
} {
  const overrides: SwarmConfigOverrides = {};
  const warnings: string[] = [];

  for (const [envVar, field, nest] of SWARM_ENV_VARS) {
    const raw = env[envVar];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      warnings.push(`ignoring ${envVar}="${raw}" — expected a positive integer`);
      continue;
    }
    if (nest === 'defaults') {
      overrides.defaults ??= {};
      overrides.defaults[field] = value;
    } else {
      overrides[field] = value;
    }
  }

  return { overrides, warnings };
}

/**
 * Read the browser-origin allowlist for the `/mobile/v1` CORS surface from
 * `DASH_WEB_ORIGINS` (comma-separated). Unset or empty yields `[]`, which
 * keeps CORS disabled on that surface. Each entry is trimmed; blank entries
 * (e.g. from a trailing comma) are dropped.
 */
export function webOriginsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.DASH_WEB_ORIGINS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function parseFlags(argv: string[]): LoadConfigOptions {
  const options: LoadConfigOptions = {};

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--management-port' && argv[i + 1]) {
      options.managementPort = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--token' && argv[i + 1]) {
      options.token = argv[i + 1];
      i++;
    } else if (argv[i] === '--data-dir' && argv[i + 1]) {
      options.dataDir = argv[i + 1];
      i++;
    } else if (argv[i] === '--channel-port' && argv[i + 1]) {
      options.channelPort = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--lan-port' && argv[i + 1]) {
      options.lanPort = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--chat-token' && argv[i + 1]) {
      options.chatToken = argv[i + 1];
      i++;
    } else if (argv[i] === '--relay-url' && argv[i + 1]) {
      options.relayUrl = argv[i + 1];
      i++;
    } else if (argv[i] === '--relay-token' && argv[i + 1]) {
      options.relayToken = argv[i + 1];
      i++;
    } else if (argv[i] === '--gateway-id' && argv[i + 1]) {
      options.gatewayId = argv[i + 1];
      i++;
    } else if (argv[i] === '--control-plane-url' && argv[i + 1]) {
      options.controlPlaneUrl = argv[i + 1];
      i++;
    } else if (argv[i] === '--verbose') {
      options.verbose = true;
    }
  }

  return options;
}

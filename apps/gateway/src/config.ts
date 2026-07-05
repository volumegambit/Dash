export interface LoadConfigOptions {
  managementPort?: number;
  channelPort?: number;
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

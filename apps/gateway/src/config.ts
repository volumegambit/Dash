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
    } else if (argv[i] === '--verbose') {
      options.verbose = true;
    }
  }

  return options;
}

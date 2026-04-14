export interface LoadConfigOptions {
  managementPort?: number;
  channelPort?: number;
  token?: string;
  chatToken?: string;
  dataDir?: string;
  verbose?: boolean;
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
    } else if (argv[i] === '--verbose') {
      options.verbose = true;
    }
  }

  return options;
}

import { Command } from 'commander';
import { registerDeployCommand } from './commands/deploy.js';
import { registerHealthCommand } from './commands/health.js';
import { registerInfoCommand } from './commands/info.js';
import { registerLockCommand } from './commands/lock.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerProvidersConnectCommand } from './commands/providers-connect.js';
import { registerProvidersDisconnectCommand } from './commands/providers-disconnect.js';
import { registerProvidersListCommand } from './commands/providers-list.js';
import { registerRemoveCommand } from './commands/remove.js';
import { registerSecretsChangePasswordCommand } from './commands/secrets-change-password.js';
import { registerSkillsCommand } from './commands/skills.js';
import { registerSecretsDeleteCommand } from './commands/secrets-delete.js';
import { registerSecretsGetCommand } from './commands/secrets-get.js';
import { registerSecretsListCommand } from './commands/secrets-list.js';
import { registerSecretsSetCommand } from './commands/secrets-set.js';
import { registerStatusCommand } from './commands/status.js';
import { registerStopCommand } from './commands/stop.js';
import { registerUnlockCommand } from './commands/unlock.js';

const program = new Command()
  .name('mc')
  .description('Mission Control CLI for managing Dash agents')
  .version('0.1.0');

registerDeployCommand(program);
registerHealthCommand(program);
registerInfoCommand(program);
registerLockCommand(program);
registerLogsCommand(program);
registerRemoveCommand(program);
registerStatusCommand(program);
registerStopCommand(program);
registerUnlockCommand(program);

// Secrets subcommand group
const secrets = program.command('secrets').description('Manage encrypted secrets');
registerSecretsListCommand(secrets);
registerSecretsGetCommand(secrets);
registerSecretsSetCommand(secrets);
registerSecretsDeleteCommand(secrets);
registerSecretsChangePasswordCommand(secrets);

// Providers subcommand group
const providers = program.command('providers').description('Manage AI provider API keys');
registerProvidersListCommand(providers);
registerProvidersConnectCommand(providers);
registerProvidersDisconnectCommand(providers);

// Skills subcommand group
registerSkillsCommand(program);

program.parse();

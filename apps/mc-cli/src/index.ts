import { Command } from 'commander';
import { registerDeployCommand } from './commands/deploy.js';
import { registerHealthCommand } from './commands/health.js';
import { registerInfoCommand } from './commands/info.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerRemoveCommand } from './commands/remove.js';
import { registerStatusCommand } from './commands/status.js';
import { registerStopCommand } from './commands/stop.js';

const program = new Command()
  .name('mc')
  .description('Mission Control CLI for managing Dash agents')
  .version('0.1.0');

registerDeployCommand(program);
registerHealthCommand(program);
registerInfoCommand(program);
registerLogsCommand(program);
registerRemoveCommand(program);
registerStatusCommand(program);
registerStopCommand(program);

program.parse();

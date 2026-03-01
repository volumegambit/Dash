import { Command } from 'commander';
import { registerHealthCommand } from './commands/health.js';
import { registerInfoCommand } from './commands/info.js';

const program = new Command()
  .name('mc')
  .description('Mission Control CLI for managing Dash agents')
  .version('0.1.0');

registerHealthCommand(program);
registerInfoCommand(program);

program.parse();

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DashAgent, OpenCodeBackend } from '@dash/agent';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

config({ path: resolve(projectRoot, '.env') });

// ── ANSI helpers (zero dependencies) ────────────────────────────────

const esc = (code: string) => `\x1b[${code}m`;
const isColorSupported = process.env.NO_COLOR === undefined && process.stdout.isTTY;

const c = isColorSupported
  ? {
      reset: esc('0'),
      bold: esc('1'),
      dim: esc('2'),
      italic: esc('3'),
      cyan: esc('36'),
      green: esc('32'),
      yellow: esc('33'),
      red: esc('31'),
      magenta: esc('35'),
      blue: esc('34'),
      gray: esc('90'),
      white: esc('97'),
      bgCyan: esc('46'),
      bgMagenta: esc('45'),
      bgRed: esc('41'),
      bgGreen: esc('42'),
      bgYellow: esc('43'),
    }
  : (Object.fromEntries(
      [
        'reset',
        'bold',
        'dim',
        'italic',
        'cyan',
        'green',
        'yellow',
        'red',
        'magenta',
        'blue',
        'gray',
        'white',
        'bgCyan',
        'bgMagenta',
        'bgRed',
        'bgGreen',
        'bgYellow',
      ].map((k) => [k, '']),
    ) as Record<string, string>);

// ── Spinner ─────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private text: string;

  constructor(text = 'thinking') {
    this.text = text;
  }

  setText(text: string) {
    this.text = text;
  }

  start() {
    if (!isColorSupported) return;
    this.frame = 0;
    this.render();
    this.timer = setInterval(() => this.render(), 80);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      // Clear the spinner line
      process.stdout.write('\r\x1b[2K');
    }
  }

  private render() {
    const f = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
    process.stdout.write(
      `\r${c.magenta}${c.bold}  dash ${c.reset}${c.dim}${f} ${this.text}...${c.reset}`,
    );
    this.frame++;
  }
}

// ── Config ──────────────────────────────────────────────────────────

interface AgentJsonConfig {
  model: string;
  systemPrompt: string;
  tools?: string[];
  workspace?: string;
}

interface DashJsonConfig {
  agents: Record<string, AgentJsonConfig>;
  channels: Record<string, { agent: string }>;
}

interface CredentialsConfig {
  providerApiKeys?: Record<string, string>;
}

async function loadDashConfig(): Promise<DashJsonConfig> {
  const candidates = [resolve(projectRoot, 'config/dash.json'), resolve(projectRoot, 'dash.json')];

  for (const path of candidates) {
    if (existsSync(path)) {
      const raw = await readFile(path, 'utf-8');
      return JSON.parse(raw);
    }
  }

  throw new Error('config/dash.json not found');
}

async function loadCredentials(): Promise<CredentialsConfig> {
  const candidates = [
    resolve(projectRoot, 'config/credentials.json'),
    resolve(projectRoot, 'credentials.json'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      const raw = await readFile(path, 'utf-8');
      return JSON.parse(raw);
    }
  }

  return {};
}

// ── Display helpers ─────────────────────────────────────────────────

function printHeader(
  agentName: string,
  model: string,
  tools: string[],
  workspace: string | undefined,
) {
  const width = 42;
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const hr = '─'.repeat(width);

  // Show a short workspace path: relative to projectRoot, or ~ for home
  const home = process.env.HOME ?? '';
  let wsDisplay = workspace ?? projectRoot;
  if (home && wsDisplay.startsWith(home)) {
    wsDisplay = `~${wsDisplay.slice(home.length)}`;
  }

  console.log();
  console.log(`  ${c.cyan}╭${hr}╮${c.reset}`);
  console.log(
    `  ${c.cyan}│${c.reset} ${c.bold}${c.magenta}⚡ Dash TUI${c.reset}${' '.repeat(width - 12)}${c.cyan}│${c.reset}`,
  );
  console.log(`  ${c.cyan}├${hr}┤${c.reset}`);
  console.log(
    `  ${c.cyan}│${c.reset} ${c.dim}agent${c.reset}  ${pad(agentName, width - 9)}${c.cyan}│${c.reset}`,
  );
  console.log(
    `  ${c.cyan}│${c.reset} ${c.dim}model${c.reset}  ${pad(shortModel(model), width - 9)}${c.cyan}│${c.reset}`,
  );
  console.log(
    `  ${c.cyan}│${c.reset} ${c.dim}tools${c.reset}  ${pad(tools.join(', ') || 'none', width - 9)}${c.cyan}│${c.reset}`,
  );
  console.log(
    `  ${c.cyan}│${c.reset} ${c.dim}path${c.reset}   ${pad(wsDisplay, width - 9)}${c.cyan}│${c.reset}`,
  );
  console.log(`  ${c.cyan}╰${hr}╯${c.reset}`);
  console.log(`  ${c.dim}Type a message. Ctrl+C to exit.${c.reset}`);
  console.log();
}

function shortModel(model: string): string {
  // model is "provider/model-id", show just the model-id portion
  const modelId = model.includes('/') ? model.split('/')[1] : model;
  return modelId.replace('claude-', '').replace(/-\d{8}$/, '');
}

function printPrompt() {
  process.stdout.write(`${c.cyan}${c.bold}   you ${c.reset}${c.cyan}› ${c.reset}`);
}

function printToolBlock(name: string, input: string, result: string, isError?: boolean) {
  const label = isError
    ? `${c.red}${c.bold}✗ ${name}${c.reset}`
    : `${c.green}${c.bold}✓ ${name}${c.reset}`;

  const indent = '       ';
  const border = c.dim;

  // Truncate long content
  const maxLines = 6;
  const truncate = (s: string) => {
    const lines = s.split('\n');
    if (lines.length <= maxLines) return lines;
    return [
      ...lines.slice(0, maxLines),
      `${c.dim}… ${lines.length - maxLines} more lines${c.reset}`,
    ];
  };

  console.log();
  console.log(
    `${indent}${border}┌─ ${c.reset}${label}${border} ${'─'.repeat(Math.max(0, 30 - name.length))}${c.reset}`,
  );

  if (input) {
    for (const line of truncate(input)) {
      console.log(`${indent}${border}│${c.reset} ${c.dim}${line}${c.reset}`);
    }
    console.log(`${indent}${border}├${'╌'.repeat(36)}${c.reset}`);
  }

  const resultLines = truncate(result);
  for (const line of resultLines) {
    const color = isError ? c.red : '';
    console.log(`${indent}${border}│${c.reset} ${color}${line}${c.reset}`);
  }

  console.log(`${indent}${border}└${'─'.repeat(36)}${c.reset}`);
}

function printUsage(usage: { inputTokens: number; outputTokens: number }) {
  console.log(`\n${c.dim}       ${usage.inputTokens}↑ ${usage.outputTokens}↓ tokens${c.reset}`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const [dashConfig, credentials] = await Promise.all([loadDashConfig(), loadCredentials()]);

  // Resolve provider API keys from env > credentials file
  const credEnvMap: Record<string, string[]> = {
    anthropic: ['ANTHROPIC_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  };
  const providerApiKeys: Record<string, string> = {};
  for (const [provider, envVars] of Object.entries(credEnvMap)) {
    const val =
      envVars.map((v) => process.env[v]).find(Boolean) ?? credentials.providerApiKeys?.[provider];
    if (val) providerApiKeys[provider] = val;
  }

  if (Object.keys(providerApiKeys).length === 0) {
    console.error(
      `\n  ${c.red}${c.bold}Error:${c.reset} No provider API keys found. Set ANTHROPIC_API_KEY (or another provider key) in config/credentials.json or environment.\n`,
    );
    process.exit(1);
  }

  const cliChannel = dashConfig.channels?.cli;
  const agentName = cliChannel?.agent ?? 'default';
  const agentConfig = dashConfig.agents[agentName];
  if (!agentConfig) {
    console.error(
      `\n  ${c.red}${c.bold}Error:${c.reset} Agent "${agentName}" not found in config.\n`,
    );
    process.exit(1);
  }

  let workspace: string | undefined;
  if (agentConfig.workspace) {
    workspace = resolve(projectRoot, agentConfig.workspace);
    await mkdir(workspace, { recursive: true });
  }

  const backend = new OpenCodeBackend(
    {
      model: agentConfig.model,
      systemPrompt: agentConfig.systemPrompt,
      tools: agentConfig.tools,
      workspace,
      skills: agentConfig.skills,
    },
    providerApiKeys,
  );
  await backend.start(workspace ?? projectRoot);

  const agent = new DashAgent(backend, {
    model: agentConfig.model,
    systemPrompt: agentConfig.systemPrompt,
    tools: agentConfig.tools,
    workspace,
  });

  printHeader(agentName, agentConfig.model, agentConfig.tools ?? [], workspace);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const conversationId = `cli:${Date.now()}`;
  let busy = false;

  printPrompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) {
      printPrompt();
      return;
    }

    if (busy) return;
    busy = true;

    const spinner = new Spinner();
    let firstToken = true;
    let currentToolInput = '';

    try {
      spinner.start();

      for await (const event of agent.chat('cli', conversationId, text)) {
        switch (event.type) {
          case 'thinking_delta':
            spinner.setText('thinking deeply');
            break;

          case 'text_delta':
            if (firstToken) {
              spinner.stop();
              process.stdout.write(
                `${c.magenta}${c.bold}  dash ${c.reset}${c.magenta}› ${c.reset}`,
              );
              firstToken = false;
            }
            process.stdout.write(event.text);
            break;

          case 'tool_use_start':
            if (firstToken) {
              spinner.stop();
              firstToken = false;
            }
            currentToolInput = '';
            break;

          case 'tool_use_delta':
            currentToolInput += event.partial_json;
            break;

          case 'tool_result': {
            // Parse tool input for display
            let inputDisplay = '';
            try {
              const parsed = JSON.parse(currentToolInput);
              if (parsed.command) inputDisplay = parsed.command;
              else if (parsed.path) inputDisplay = parsed.path;
              else inputDisplay = currentToolInput;
            } catch {
              inputDisplay = currentToolInput;
            }

            printToolBlock(event.name, inputDisplay, event.content, event.isError);
            // After a tool block, next text needs the dash prompt again
            firstToken = true;
            break;
          }

          case 'response':
            spinner.stop();
            printUsage(event.usage);
            break;

          case 'error':
            spinner.stop();
            console.log(
              `\n  ${c.red}${c.bold}  error ${c.reset}${c.red}› ${event.error.message}${c.reset}`,
            );
            break;
        }
      }
    } catch (err) {
      spinner.stop();
      console.log(
        `\n  ${c.red}${c.bold}  error ${c.reset}${c.red}› ${err instanceof Error ? err.message : err}${c.reset}`,
      );
    }

    console.log();
    busy = false;
    printPrompt();
  });

  rl.on('close', async () => {
    console.log(`\n  ${c.dim}Bye! 👋${c.reset}\n`);
    await backend.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`${c.red}Fatal:${c.reset}`, err);
  process.exit(1);
});

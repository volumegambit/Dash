import { type MobileTestHarnessScenario, startMobileTestHarness } from './mobile-test-harness.js';

const scenarios = new Set<MobileTestHarnessScenario>(['stream', 'question', 'slow']);

export function parseMobileTestHarnessScenario(args: string[]): MobileTestHarnessScenario {
  if (args.length === 0) return 'stream';
  const scenario = args[1] as MobileTestHarnessScenario | undefined;
  if (args.length !== 2 || args[0] !== '--scenario' || !scenario || !scenarios.has(scenario)) {
    throw new Error('Usage: mobile:test-harness -- --scenario stream|question|slow');
  }
  return scenario;
}

async function main(): Promise<void> {
  const scenario = parseMobileTestHarnessScenario(process.argv.slice(2));
  const harness = await startMobileTestHarness({ scenario });
  let stopping = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.error(`[mobile-test-harness] received ${signal}; stopping`);
    void harness
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(
          '[mobile-test-harness] shutdown failed:',
          error instanceof Error ? error.message : String(error),
        );
        process.exit(1);
      });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.error(`[mobile-test-harness] ready (${scenario})`);
  process.stdout.write(
    `${JSON.stringify({
      type: 'ready',
      managementBaseUrl: harness.managementBaseUrl,
      chatWebSocketUrl: harness.chatWebSocketUrl,
      managementToken: harness.managementToken,
      chatToken: harness.chatToken,
      gatewayId: harness.gatewayId,
      agentId: harness.agentId,
      dataDir: harness.dataDir,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  console.error(
    '[mobile-test-harness] failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});

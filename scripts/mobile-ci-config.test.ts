import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

describe('mobile CI wiring', () => {
  it('runs iOS CI for contract and gateway protocol changes', async () => {
    const source = await readFile('.github/workflows/ios.yml', 'utf8');
    const workflow = parse(source);
    const pullRequestPaths = workflow?.on?.pull_request?.paths ?? [];
    const pushPaths = workflow?.on?.push?.paths ?? [];
    const branches = workflow?.on?.pull_request?.branches ?? [];
    const steps = workflow?.jobs?.ios?.steps ?? [];
    const commands = steps.map((step: { run?: string }) => step.run ?? '').join('\n');
    const step = (name: string) =>
      steps.find((candidate: { name?: string }) => candidate.name === name)?.run ?? '';

    for (const paths of [pullRequestPaths, pushPaths]) {
      expect(paths).toEqual(
        expect.arrayContaining([
          'ios/**',
          'contracts/mobile/v1/**',
          'apps/gateway/**',
          'packages/**',
        ]),
      );
    }
    expect(pullRequestPaths).toEqual(pushPaths);
    expect(branches).toEqual(expect.arrayContaining(['main', 'codex/mc-vps-gateway-relay']));
    expect(commands).toContain('ios/scripts/check-project.sh');
    expect(commands).toContain('ios/scripts/ensure-simulators.sh');
    expect(commands).toContain('npm run build');
    expect(commands).toContain('npm run mobile:contract-check');
    expect(commands).toContain('-only-testing:DashIntegrationTests/LiveGatewayEnvironmentTests');
    expect(commands).toContain('run-live-gateway-tests.mjs');
    expect(step('Build Release simulator app and verify bundle metadata')).toEqual(
      expect.stringContaining('-configuration Release'),
    );
    expect(step('Build Release simulator app and verify bundle metadata')).toEqual(
      expect.stringContaining(
        '$simulator_derived_data/Build/Products/Release-iphonesimulator/Dash.app',
      ),
    );
    expect(step('Generic Release iOS build without signing')).toEqual(
      expect.stringContaining('-configuration Release'),
    );
    expect(step('Generic Release iOS build without signing')).toEqual(
      expect.stringContaining('$device_derived_data/Build/Products/Release-iphoneos/Dash.app'),
    );
    expect(commands.indexOf('npm run build')).toBeLessThan(
      commands.indexOf('run-live-gateway-tests.mjs'),
    );
  });

  it('runs Node gates for both final and temporary PR bases', async () => {
    const source = await readFile('.github/workflows/ci.yml', 'utf8');
    const workflow = parse(source);
    const branches = workflow?.on?.pull_request?.branches ?? [];
    const commands = (workflow?.jobs?.ci?.steps ?? [])
      .map((step: { run?: string }) => step.run ?? '')
      .join('\n');

    expect(branches).toEqual(expect.arrayContaining(['main', 'codex/mc-vps-gateway-relay']));
    expect(commands).toContain('npm run mobile:contract-check');
    expect(commands.indexOf('npm run mobile:contract-check')).toBeLessThan(
      commands.indexOf('npm test'),
    );
  });

  it('runs Android gates for both final and temporary PR bases', async () => {
    const source = await readFile('.github/workflows/android.yml', 'utf8');
    const workflow = parse(source);
    const pullRequestPaths = workflow?.on?.pull_request?.paths ?? [];
    const pushPaths = workflow?.on?.push?.paths ?? [];
    const branches = workflow?.on?.pull_request?.branches ?? [];
    const commands = (workflow?.jobs?.android?.steps ?? [])
      .map((step: { run?: string }) => step.run ?? '')
      .join('\n');

    for (const paths of [pullRequestPaths, pushPaths]) {
      expect(paths).toEqual(
        expect.arrayContaining([
          'android/**',
          'contracts/mobile/v1/**',
          'apps/gateway/**',
          'apps/mission-control/src/main/ipc.ts',
          'apps/mission-control/src/main/pairing.ts',
          'apps/mission-control/src/renderer/src/components/PairDeviceCard.tsx',
          'apps/mission-control/src/shared/ipc.ts',
          'packages/agent/**',
          '.github/workflows/android.yml',
        ]),
      );
    }
    expect(pullRequestPaths).toEqual(pushPaths);
    expect(branches).toEqual(expect.arrayContaining(['main', 'codex/mc-vps-gateway-relay']));
    expect(commands).toContain('./gradlew test');
    expect(commands).toContain('./gradlew assembleDebug');
  });
});

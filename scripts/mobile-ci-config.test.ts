import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

describe('mobile CI wiring', () => {
  it('runs iOS CI for contract and gateway protocol changes', async () => {
    const source = await readFile('.github/workflows/ios.yml', 'utf8');
    const workflow = parse(source);
    const paths = workflow?.on?.pull_request?.paths ?? [];
    const branches = workflow?.on?.pull_request?.branches ?? [];
    const steps = workflow?.jobs?.ios?.steps ?? [];
    const commands = steps.map((step: { run?: string }) => step.run ?? '').join('\n');

    expect(paths).toEqual(
      expect.arrayContaining(['ios/**', 'contracts/mobile/v1/**', 'apps/gateway/src/**']),
    );
    expect(branches).toEqual(expect.arrayContaining(['main', 'codex/mc-vps-gateway-relay']));
    expect(commands).toContain('ios/scripts/check-project.sh');
    expect(commands).toContain('ios/scripts/ensure-simulators.sh');
    expect(commands).toContain('npm run build');
    expect(commands).toContain('npm run mobile:contract-check');
    expect(commands).toContain('run-live-gateway-tests.mjs');
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
});

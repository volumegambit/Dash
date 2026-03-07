import type { DeployWithConfigOptions, MissionControlAPI, SetupStatus } from './ipc.js';

// These tests verify the IPC contract types are structurally correct.
// They use TypeScript's type system — if the interface changes incompatibly, these fail to compile.

describe('MissionControlAPI contract', () => {
  it('SetupStatus has required fields', () => {
    const status: SetupStatus = { needsSetup: true, needsApiKey: false };
    expect(status.needsSetup).toBe(true);
    expect(status.needsApiKey).toBe(false);
  });

  it('DeployWithConfigOptions has required fields', () => {
    const options: DeployWithConfigOptions = {
      name: 'test-agent',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
      tools: ['read_file'],
      enableTelegram: false,
    };
    expect(options.name).toBe('test-agent');
    expect(options.model).toContain('claude');
    expect(options.tools).toHaveLength(1);
    expect(options.enableTelegram).toBe(false);
  });

  it('MissionControlAPI exposes all deployment methods', () => {
    // Type-level check: if any of these methods are removed from the interface,
    // this test will fail to compile.
    const methodNames: (keyof MissionControlAPI)[] = [
      'deploymentsList',
      'deploymentsGet',
      'deploymentsDeploy',
      'deploymentsDeployWithConfig',
      'deploymentsStop',
      'deploymentsRemove',
      'deploymentsGetStatus',
      'deploymentsLogsSubscribe',
      'deploymentsLogsUnsubscribe',
      'onDeploymentLog',
      'onDeploymentStatusChange',
    ];
    // Each key must be a valid member of the interface (enforced at compile time)
    expect(methodNames).toHaveLength(11);
  });

  it('MissionControlAPI exposes all secrets methods', () => {
    const methodNames: (keyof MissionControlAPI)[] = [
      'secretsNeedsSetup',
      'secretsNeedsMigration',
      'secretsIsUnlocked',
      'secretsSetup',
      'secretsUnlock',
      'secretsLock',
      'secretsList',
      'secretsGet',
      'secretsSet',
      'secretsDelete',
    ];
    expect(methodNames).toHaveLength(10);
  });

  it('MissionControlAPI exposes setup and shell methods', () => {
    const methodNames: (keyof MissionControlAPI)[] = [
      'getVersion',
      'openExternal',
      'setupGetStatus',
    ];
    expect(methodNames).toHaveLength(3);
  });

  it('MissionControlAPI exposes chat methods', () => {
    const methodNames: (keyof MissionControlAPI)[] = [
      'chatConnect',
      'chatDisconnect',
      'chatSend',
      'chatOnResponse',
      'chatOnError',
    ];
    expect(methodNames).toHaveLength(5);
  });
});

import { readFile } from 'node:fs/promises';

describe('mobile documentation', () => {
  it('documents both pairing clients and the iOS shared-history boundary', async () => {
    const [root, gettingStarted, remote, architecture, api, troubleshooting, ios, qa, mcQA] =
      await Promise.all([
        readFile('README.md', 'utf8'),
        readFile('docs/getting-started.mdx', 'utf8'),
        readFile('docs/remote-access.mdx', 'utf8'),
        readFile('docs/architecture.mdx', 'utf8'),
        readFile('docs/api-reference.mdx', 'utf8'),
        readFile('docs/troubleshooting.mdx', 'utf8'),
        readFile('ios/README.md', 'utf8'),
        readFile('ios/QA_CHECKLIST.md', 'utf8'),
        readFile('apps/mission-control/TEST_PLAN.md', 'utf8'),
      ]);

    expect(root).toContain('| `ios/` |');
    expect(root).toContain('| `android/` |');
    expect(gettingStarted).toContain('Settings → Devices');
    expect(gettingStarted).toContain('ios/README.md');
    expect(remote).toContain('Dash iOS or Android app');
    expect(remote).toContain('Android remains a legacy, non-resumable client');
    expect(architecture).toContain('gateway-authoritative conversation history');
    expect(architecture).toContain('Android remains a legacy, non-resumable client');
    expect(api).toContain('GET /conversations');
    expect(api).toContain('conversation-sync-v1');
    expect(api).toContain('accepted');
    expect(api).toContain('resume');
    expect(troubleshooting).toContain('Active on another device');
    expect(troubleshooting).toContain('Local Network');
    expect(ios).toContain('run-live-gateway-tests.mjs');
    expect(qa).toContain('## Pairing and security');
    expect(qa).toContain('## Conversation synchronization');
    expect(qa).toContain('## Device quality');
    expect(qa).not.toMatch(/- \[x\]/i);
    expect(mcQA).toContain('On this Mac');
    expect(mcQA).toContain('Scan this code with the Dash mobile app for Android or iOS.');
  });
});

import { readFile } from 'node:fs/promises';

describe('mobile documentation', () => {
  it('documents both pairing clients and the iOS shared-history boundary', async () => {
    const [
      root,
      gettingStarted,
      remote,
      architecture,
      api,
      troubleshooting,
      iosGuide,
      docsConfig,
      ios,
      qa,
      mcQA,
    ] = await Promise.all([
      readFile('README.md', 'utf8'),
      readFile('docs/getting-started.mdx', 'utf8'),
      readFile('docs/remote-access.mdx', 'utf8'),
      readFile('docs/architecture.mdx', 'utf8'),
      readFile('docs/api-reference.mdx', 'utf8'),
      readFile('docs/troubleshooting.mdx', 'utf8'),
      readFile('docs/ios.mdx', 'utf8'),
      readFile('docs/docs.json', 'utf8'),
      readFile('ios/README.md', 'utf8'),
      readFile('ios/QA_CHECKLIST.md', 'utf8'),
      readFile('apps/mission-control/TEST_PLAN.md', 'utf8'),
    ]);

    expect(root).toContain('| `ios/` |');
    expect(root).toContain('| `android/` |');
    expect(gettingStarted).toContain('Settings → Devices');
    expect(gettingStarted).toContain('[Dash for iPhone and iPad](/ios)');
    expect(iosGuide).toContain('## Pair your device');
    expect(iosGuide).toContain('## Chat from your phone');
    expect(iosGuide).toContain('## Manage agents');
    expect(iosGuide).toContain('Disconnect & Forget');
    expect(docsConfig).toContain('"ios"');
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
    expect(mcQA).toContain('On this Mac');
    expect(mcQA).toContain('Scan this code with the Dash mobile app for Android or iOS.');
  });

  it('distinguishes native Mobile bearer auth from desktop loopback credentials', async () => {
    const [api, troubleshooting] = await Promise.all([
      readFile('docs/api-reference.mdx', 'utf8'),
      readFile('docs/troubleshooting.mdx', 'utf8'),
    ]);

    expect(api).toContain('pinned HTTPS/WSS listener on port `9400`');
    expect(api).toContain('one phone-scoped Mobile bearer');
    expect(api).toContain('Authorization: Bearer <your-mobile-token>');
    expect(api).toContain('Desktop loopback clients continue to use');
    expect(api).toContain(
      'Native WebSocket clients send that same bearer in the `Authorization` header',
    );
    expect(troubleshooting).toContain('same phone-scoped Mobile bearer');
    expect(troubleshooting).toContain(
      '`Authorization` header for both `/mobile/v1` and `/ws/chat`',
    );
    expect(troubleshooting).toContain('`x-dash-relay-credential`');
    expect(troubleshooting).not.toContain('`/ws/chat` uses the separate chat token in `?token=`');
  });

  it('keeps every remaining hardware-only check explicit', async () => {
    const qa = await readFile('ios/QA_CHECKLIST.md', 'utf8');

    expect(qa).toMatch(/- \[[ x]\] Local Network permission denied/i);
    expect(qa).toMatch(/- \[[ x]\] App termination\/relaunch/i);
    expect(qa).toMatch(/- \[[ x]\] Uninstall\/reinstall/i);
    expect(qa).toMatch(/- \[[ x]\] Hardware keyboard/i);
  });

  it('documents safe recovery when an ambiguous send loses its conversation', async () => {
    const [guide, readme] = await Promise.all([
      readFile('docs/ios.mdx', 'utf8'),
      readFile('ios/README.md', 'utf8'),
    ]);

    for (const document of [guide, readme]) {
      expect(document).toContain('Needs Recovery');
      expect(document).toContain('never recreates or resends');
      expect(document).toContain('copy the exact text');
      expect(document).toContain('preview or share its attachments');
    }
    expect(readme).toContain('Mobile bearer and optional relay credential');
  });
});

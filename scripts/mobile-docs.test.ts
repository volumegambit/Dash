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
    expect(iosGuide).toContain('## Sign in');
    expect(iosGuide).toContain('## Chat from your phone');
    expect(iosGuide).toContain('## Manage agents');
    expect(iosGuide).toContain('Disconnect & Forget');
    expect(docsConfig).toContain('"ios"');
    expect(remote).toContain('Dash for Android connects to your gateway over your local Wi-Fi');
    expect(remote).toContain('Dash for iOS always connects through the hosted relay');
    expect(remote).toContain('Android remains a legacy, non-resumable client');
    expect(architecture).toContain('gateway-authoritative conversation history');
    expect(architecture).toContain('Android remains a legacy, non-resumable client');
    expect(api).toContain('GET /conversations');
    expect(api).toContain('conversation-sync-v1');
    expect(api).toContain('accepted');
    expect(api).toContain('resume');
    expect(troubleshooting).toContain('Active on another device');
    expect(troubleshooting).toContain('re-enrolled from Mission Control before app access works');
    expect(troubleshooting).toContain(
      "Couldn't reach your Dash account service. Check your connection and try again.",
    );
    expect(troubleshooting).toContain(
      'No gateways linked to your account yet. Open Mission Control → Settings → Devices → Remote access to enroll this machine.',
    );
    expect(ios).toContain('run-live-gateway-tests.mjs');
    expect(ios).toContain('run-live-account-flow-test.mjs');
    expect(ios).toContain('fails 7 tests');
    expect(qa).toContain('## Sign-in and security');
    expect(qa).toContain('## Conversation synchronization');
    expect(qa).toContain('## Device quality');
    expect(mcQA).toContain('On this Mac');
    expect(mcQA).toContain('Scan this code with the Dash mobile app for Android.');
  });

  it('distinguishes native Mobile bearer auth from desktop loopback credentials', async () => {
    const [api, troubleshooting] = await Promise.all([
      readFile('docs/api-reference.mdx', 'utf8'),
      readFile('docs/troubleshooting.mdx', 'utf8'),
    ]);

    expect(api).toContain('configured mobile port, which defaults to `9400`');
    expect(api).toContain('Both frozen pairing port fields carry that same listener port');
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

    expect(qa).toMatch(/- \[[ x]\] App termination\/relaunch/i);
    expect(qa).toMatch(/- \[[ x]\] Uninstall\/reinstall/i);
    expect(qa).toMatch(/- \[[ x]\] Hardware keyboard/i);
  });

  it('documents safe manual recovery for deleted or unreadable pending sends', async () => {
    const [guide, readme, troubleshooting] = await Promise.all([
      readFile('docs/ios.mdx', 'utf8'),
      readFile('ios/README.md', 'utf8'),
      readFile('docs/troubleshooting.mdx', 'utf8'),
    ]);

    for (const document of [guide, readme]) {
      expect(document).toContain('Needs Recovery');
      expect(document).toContain('never recreates or resends');
      expect(document).toContain('copy the exact text');
      expect(document).toContain('preview or share its readable attachments');
      expect(document).toContain('unreadable saved attachment data');
      expect(document).toContain('read-only until you explicitly discard');
      expect(document).toContain('cannot be previewed or shared');
    }
    expect(troubleshooting).toContain('<Accordion title="Message saved for recovery">');
    expect(troubleshooting).toContain('Open **Needs Recovery**');
    expect(troubleshooting).toContain('read-only until you explicitly discard');
    expect(readme).toContain('Mobile bearer and optional relay credential');
  });

  it('keeps mobile pairing and conversation-start wording aligned with the shipped apps', async () => {
    const [guide, troubleshooting, ipcContract] = await Promise.all([
      readFile('docs/ios.mdx', 'utf8'),
      readFile('docs/troubleshooting.mdx', 'utf8'),
      readFile('apps/mission-control/src/shared/ipc.ts', 'utf8'),
    ]);

    expect(guide).toContain('Start a conversation by choosing an agent.');
    expect(guide).not.toContain('optional title');
    expect(ipcContract).toContain('// Pairing (mobile apps)');
    expect(troubleshooting).toContain('No usable LAN IPv4 address is available');
    expect(troubleshooting).toContain('same network as the phone');
    expect(troubleshooting).toContain('Switch to the local gateway before pairing a device');
    expect(troubleshooting).toContain('**Settings → General → Gateway**');
    expect(troubleshooting).toContain('**Use this computer**');
  });

  it('keeps iOS account sign-in copy and QR-retirement scoping consistent', async () => {
    const [guide, readme, qa, remote, troubleshooting, pairDeviceCard, pairDeviceCardTest] =
      await Promise.all([
        readFile('docs/ios.mdx', 'utf8'),
        readFile('ios/README.md', 'utf8'),
        readFile('ios/QA_CHECKLIST.md', 'utf8'),
        readFile('docs/remote-access.mdx', 'utf8'),
        readFile('docs/troubleshooting.mdx', 'utf8'),
        readFile('apps/mission-control/src/renderer/src/components/PairDeviceCard.tsx', 'utf8'),
        readFile(
          'apps/mission-control/src/renderer/src/components/PairDeviceCard.test.tsx',
          'utf8',
        ),
      ]);

    // Global-constraints copy (GatewayPickerView.AccountCopy) — binding, verbatim.
    for (const document of [guide, readme]) {
      expect(document).toContain(
        "Couldn't reach your Dash account service. Check your connection and try again.",
      );
      expect(document).toContain(
        'No gateways linked to your account yet. Open Mission Control → Settings → Devices → Remote access to enroll this machine.',
      );
      expect(document).toContain(
        'This gateway needs to be re-enrolled from Mission Control before app access works.',
      );
    }
    // The signer-device-approval feature this copy is reserved for has not shipped.
    for (const document of [guide, readme, qa]) {
      expect(document).not.toContain('signer device');
    }

    expect(guide).toContain('gateway picker');
    expect(guide).not.toContain('Scan the displayed QR code');
    expect(readme).toContain('run-live-account-flow-test.mjs');
    expect(readme).not.toContain('scanning, pasting, or entering a pairing code');

    expect(qa).toContain('## Sign-in and security');
    expect(qa).toContain('Disconnect & Forget, then reconnect from the gateway picker');
    expect(qa).not.toContain('paste/manual fallback');

    expect(remote).toContain('Dash for iOS always connects through the hosted relay');
    expect(remote).not.toContain('Scan it with the Dash iOS or Android app');

    expect(troubleshooting).not.toContain('iPhone cannot reach a gateway on local Wi-Fi');

    // notEnrolled has a working, self-service remedy (`healEnrolledGatewayChatToken` re-pushes
    // the chat token on every local-gateway launch) — docs must point at that, not a dead end.
    for (const document of [guide, troubleshooting, readme]) {
      expect(document).toContain('updates the gateway');
      expect(document).not.toContain('redo Remote access setup');
    }

    expect(pairDeviceCard).toContain('Scan this code with the Dash mobile app for Android.');
    expect(pairDeviceCard).not.toContain('for Android or iOS');
    expect(pairDeviceCardTest).toContain('Scan this code with the Dash mobile app for Android.');
  });
});

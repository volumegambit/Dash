import {
  buildVpsGatewayDeployScript,
  deployGatewayToVps,
  deriveRelayConnectionUrls,
} from './vps-gateway-deploy.js';

describe('deriveRelayConnectionUrls', () => {
  it('derives HTTPS/WSS gateway URLs from a secure relay origin', () => {
    expect(deriveRelayConnectionUrls('wss://relay.example.com', 'alice-mbp')).toEqual({
      managementBaseUrl: 'https://alice-mbp.relay.example.com',
      chatBaseUrl: 'wss://alice-mbp.relay.example.com',
    });
  });

  it('derives HTTP/WS gateway URLs from an insecure relay origin', () => {
    expect(deriveRelayConnectionUrls('http://relay.local:8788', 'demo')).toEqual({
      managementBaseUrl: 'http://demo.relay.local:8788',
      chatBaseUrl: 'ws://demo.relay.local:8788',
    });
  });

  it('rejects non-DNS gateway ids', () => {
    expect(() => deriveRelayConnectionUrls('wss://relay.example.com', 'Bad_Label')).toThrow(
      /DNS-safe/,
    );
  });
});

describe('buildVpsGatewayDeployScript', () => {
  it('builds a systemd user service with relay and gateway tokens', () => {
    const script = buildVpsGatewayDeployScript({
      host: '203.0.113.10',
      gatewayId: 'alice-mbp',
      relayUrl: 'wss://relay.example.com',
      relayToken: 'relay-secret',
      managementToken: 'mgmt-secret',
      chatToken: 'chat-secret',
      installDir: '~/dash',
      dataDir: '~/.dash/gateway',
      repoUrl: 'https://github.com/example/Dash.git',
      branch: 'feature/remote',
    });

    expect(script).toContain('git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"');
    expect(script).toContain('--relay-url $RELAY_URL');
    expect(script).toContain('--relay-token $RELAY_TOKEN');
    expect(script).toContain('--gateway-id $GATEWAY_ID');
    expect(script).toContain('--token $MANAGEMENT_TOKEN');
    expect(script).toContain('--chat-token $CHAT_TOKEN');
    expect(script).toContain('systemctl --user enable --now dash-gateway.service');
  });
});

describe('deployGatewayToVps', () => {
  it('runs ssh with the generated script and returns the relay connection URLs', async () => {
    const calls: Array<{ args: string[]; script: string }> = [];
    const result = await deployGatewayToVps(
      {
        host: 'vps.example.com',
        user: 'dash',
        sshPort: 2222,
        sshKeyPath: '/keys/id_ed25519',
        gatewayId: 'gw-1',
        relayUrl: 'wss://relay.example.com',
        relayToken: 'relay-secret',
        managementToken: 'mgmt-secret',
        chatToken: 'chat-secret',
      },
      {
        async run(args, script) {
          calls.push({ args, script });
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      '-p',
      '2222',
      '-i',
      '/keys/id_ed25519',
      'dash@vps.example.com',
      'bash -s',
    ]);
    expect(calls[0].script).toContain('GATEWAY_ID=');
    expect(result).toEqual({
      name: 'gw-1',
      managementBaseUrl: 'https://gw-1.relay.example.com',
      chatBaseUrl: 'wss://gw-1.relay.example.com',
    });
  });
});

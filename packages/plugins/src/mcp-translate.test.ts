import { translateMcpJson } from './mcp-translate.js';

describe('translateMcpJson', () => {
  it('translates a stdio server', () => {
    const out = translateMcpJson(
      { mcpServers: { db: { command: 'node', args: ['s.js'], env: { K: 'v' } } } },
      'myplugin',
    );
    expect(out).toEqual([
      {
        name: 'myplugin-db',
        transport: { type: 'stdio', command: 'node', args: ['s.js'] },
        env: { K: 'v' },
      },
    ]);
  });

  it('maps Claude "http" to Dash "streamable-http" and carries headers', () => {
    const out = translateMcpJson(
      { mcpServers: { api: { type: 'http', url: 'https://x/mcp', headers: { A: 'b' } } } },
      'p',
    );
    expect(out[0].transport).toEqual({
      type: 'streamable-http',
      url: 'https://x/mcp',
      headers: { A: 'b' },
    });
    expect(out[0].name).toBe('p-api');
  });

  it('passes through sse', () => {
    const out = translateMcpJson({ mcpServers: { s: { type: 'sse', url: 'https://x/sse' } } }, 'p');
    expect(out[0].transport).toEqual({ type: 'sse', url: 'https://x/sse' });
  });

  it('returns [] for missing/empty mcpServers', () => {
    expect(translateMcpJson({}, 'p')).toEqual([]);
    expect(translateMcpJson({ mcpServers: {} }, 'p')).toEqual([]);
    expect(translateMcpJson(null, 'p')).toEqual([]);
  });

  it('throws on a server name that breaks Dash rules after namespacing', () => {
    // server key with "__" would survive into the namespaced name → invalid
    expect(() => translateMcpJson({ mcpServers: { a__b: { command: 'x' } } }, 'p')).toThrow(
      /invalid/i,
    );
  });

  it('throws on an unsupported transport type (ws not supported)', () => {
    expect(() =>
      translateMcpJson({ mcpServers: { s: { type: 'ws', url: 'wss://x' } } }, 'p'),
    ).toThrow(/unsupported|ws/i);
  });

  it('throws on a stdio server missing command', () => {
    expect(() => translateMcpJson({ mcpServers: { s: {} } }, 'p')).toThrow(/command/);
  });
});

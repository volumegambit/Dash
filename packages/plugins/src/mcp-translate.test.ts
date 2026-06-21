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

  it('throws on args with a non-string element', () => {
    expect(() =>
      translateMcpJson({ mcpServers: { s: { command: 'node', args: ['ok', 123, null] } } }, 'p'),
    ).toThrow(/args must be an array of strings/);
  });

  it('carries through a valid string args array', () => {
    const out = translateMcpJson({ mcpServers: { s: { command: 'node', args: ['a', 'b'] } } }, 'p');
    expect(out[0].transport).toEqual({ type: 'stdio', command: 'node', args: ['a', 'b'] });
  });

  it('throws on env with a non-string value', () => {
    expect(() =>
      translateMcpJson({ mcpServers: { s: { command: 'node', env: { K: 123 } } } }, 'p'),
    ).toThrow(/env/);
  });

  it('throws on headers with a non-string value', () => {
    expect(() =>
      translateMcpJson(
        { mcpServers: { s: { type: 'http', url: 'https://x', headers: { A: [] } } } },
        'p',
      ),
    ).toThrow(/headers/);
  });

  it('passes through an explicit streamable-http type', () => {
    const out = translateMcpJson(
      { mcpServers: { s: { type: 'streamable-http', url: 'https://x' } } },
      'p',
    );
    expect(out[0].transport).toEqual({ type: 'streamable-http', url: 'https://x' });
  });

  it('throws on a prototype-polluting server key and does not pollute Object.prototype', () => {
    // JSON.parse produces a real "__proto__" own-key (unlike an object literal),
    // matching the real .mcp.json input path. Namespaced 'p-__proto__' contains '__' → invalid.
    const raw = JSON.parse('{"mcpServers":{"__proto__":{"command":"x"}}}');
    expect(() => translateMcpJson(raw, 'p')).toThrow(/invalid/i);
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });

  it('throws on a non-object server value', () => {
    expect(() => translateMcpJson({ mcpServers: { x: 'str' } }, 'p')).toThrow();
  });

  it('returns [] when mcpServers is an array', () => {
    expect(translateMcpJson({ mcpServers: [] }, 'p')).toEqual([]);
  });
});

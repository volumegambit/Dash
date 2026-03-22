import type { McpServerConfig } from './types.js';
import { McpProposalStore } from './proposals.js';

describe('McpProposalStore', () => {
  const sampleConfig: McpServerConfig = {
    name: 'jira',
    transport: { type: 'sse', url: 'https://jira.example.com/mcp' },
  };

  it('stores and retrieves a proposal', () => {
    const store = new McpProposalStore();
    store.add('jira', sampleConfig);
    const proposal = store.get('jira');
    expect(proposal).toBeDefined();
    expect(proposal?.config.name).toBe('jira');
  });

  it('returns undefined for non-existent proposal', () => {
    const store = new McpProposalStore();
    expect(store.get('ghost')).toBeUndefined();
  });

  it('removes a proposal', () => {
    const store = new McpProposalStore();
    store.add('jira', sampleConfig);
    store.remove('jira');
    expect(store.get('jira')).toBeUndefined();
  });

  it('returns undefined for expired proposals', async () => {
    const store = new McpProposalStore(50); // 50ms TTL
    store.add('jira', sampleConfig);
    expect(store.get('jira')).toBeDefined();

    await new Promise((r) => setTimeout(r, 100));
    expect(store.get('jira')).toBeUndefined();
  });

  it('overwrites existing proposals', () => {
    const store = new McpProposalStore();
    store.add('jira', sampleConfig);
    const updated: McpServerConfig = {
      name: 'jira',
      transport: { type: 'sse', url: 'https://jira-v2.example.com/mcp' },
    };
    store.add('jira', updated);
    const proposal = store.get('jira');
    expect((proposal?.config.transport as { url: string }).url).toBe(
      'https://jira-v2.example.com/mcp',
    );
  });

  it('lists all active (non-expired) proposals', () => {
    const store = new McpProposalStore();
    store.add('jira', sampleConfig);
    store.add('github', { name: 'github', transport: { type: 'stdio', command: 'gh-mcp' } });
    const all = store.listActive();
    expect(all).toHaveLength(2);
  });
});

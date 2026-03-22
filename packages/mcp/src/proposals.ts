import type { McpServerConfig } from './types.js';

export interface McpProposal {
  config: McpServerConfig;
  createdAt: number;
}

const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * In-memory store for pending MCP server proposals.
 * Proposals expire after a configurable TTL.
 */
export class McpProposalStore {
  private proposals = new Map<string, McpProposal>();
  private readonly ttl: number;

  constructor(ttl?: number) {
    this.ttl = ttl ?? DEFAULT_TTL;
  }

  add(name: string, config: McpServerConfig): void {
    this.proposals.set(name, { config, createdAt: Date.now() });
  }

  get(name: string): McpProposal | undefined {
    const proposal = this.proposals.get(name);
    if (!proposal) return undefined;

    if (Date.now() - proposal.createdAt > this.ttl) {
      this.proposals.delete(name);
      return undefined;
    }

    return proposal;
  }

  remove(name: string): void {
    this.proposals.delete(name);
  }

  listActive(): McpProposal[] {
    const now = Date.now();
    const active: McpProposal[] = [];
    for (const [name, proposal] of this.proposals) {
      if (now - proposal.createdAt > this.ttl) {
        this.proposals.delete(name);
      } else {
        active.push(proposal);
      }
    }
    return active;
  }
}

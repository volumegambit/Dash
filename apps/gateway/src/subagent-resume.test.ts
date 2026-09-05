import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildSpec } from '@dash/swarm';
import type { GatewayAgentConfig } from './agent-registry.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import {
  type ChildSpecReconstructionDeps,
  childAttachOverrides,
  grantFromSpec,
  reconstructChildSpec,
} from './subagent-resume.js';

const AGENT_ID = 'agent-01';

function config(over: Partial<GatewayAgentConfig> = {}): GatewayAgentConfig {
  return { name: 'Helper', model: 'test/model', systemPrompt: 'sp', ...over };
}

function specFor(childId: string, parentConversationId: string): Omit<ChildSpec, 'extraTools'> {
  return {
    agentId: AGENT_ID,
    agentName: 'Helper',
    runId: 'parent-turn-1',
    workerId: childId,
    childConversationId: childId,
    parentConversationId,
    parentTurnId: 'parent-turn-1',
    role: 'scout',
    brief: 'survey the repo',
    model: 'test/model',
    workspace: '/repo',
    tools: ['read', 'bash'],
    mcpTools: ['github__pr'],
    subagentType: 'general-purpose',
    description: 'survey repo',
    name: 'scout',
    systemPrompt: 'the definition body',
    depth: 1,
  };
}

describe('reconstructChildSpec', () => {
  let tmpDir: string;
  let conversations: SqliteConversationService;
  let uuidCounter: number;
  /** What the AGENT holds right now — the live bound every rebuild is cut to. */
  let agentTools: string[] | undefined;
  let agentMcp: string[];
  let agents: Map<string, GatewayAgentConfig>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'subagent-resume-'));
    uuidCounter = 0;
    conversations = new SqliteConversationService({
      dataDir: tmpDir,
      uuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
    });
    agentTools = ['read', 'bash', 'mcp'];
    agentMcp = ['github__pr', 'github__merge'];
    agents = new Map([[AGENT_ID, config({ tools: agentTools })]]);
  });

  afterEach(async () => {
    conversations.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function deps(over: Partial<ChildSpecReconstructionDeps> = {}): ChildSpecReconstructionDeps {
    return {
      conversations,
      liveSpec: () => undefined,
      agentConfig: (id) => agents.get(id),
      agentMcpTools: () => agentMcp,
      ...over,
    };
  }

  function parentConversation() {
    return conversations.create({
      agentId: AGENT_ID,
      agentName: 'Helper',
      requestId: `req-${++uuidCounter}`,
    });
  }

  /** A persisted child of `parentId`, exactly as a spawn leaves one behind. */
  function persistChild(
    parentId: string,
    childId: string,
    over: Partial<Omit<ChildSpec, 'extraTools'>> = {},
  ): Omit<ChildSpec, 'extraTools'> {
    const spec = { ...specFor(childId, parentId), ...over };
    conversations.createSubagent({
      id: childId,
      agentId: spec.agentId,
      agentName: spec.agentName,
      parentConversationId: parentId,
      parentTurnId: spec.parentTurnId,
      title: spec.description ?? spec.role,
      subagent: {
        type: spec.subagentType ?? 'general-purpose',
        ...(spec.name !== undefined ? { name: spec.name } : {}),
        status: 'done',
        description: spec.description ?? spec.role,
        prompt: spec.brief,
        model: spec.model,
        background: spec.background ?? false,
        depth: spec.depth ?? 1,
        startedAt: '2026-09-05T00:00:00.000Z',
        toolCallCount: 0,
        oneShot: spec.oneShot ?? false,
      },
    });
    conversations.putSubagentGrant(childId, grantFromSpec(spec));
    return spec;
  }

  it('rebuilds the resolved spec of a child this process no longer holds one for', () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_A');

    expect(reconstructChildSpec('sub_A', deps())).toEqual({
      agentId: AGENT_ID,
      agentName: 'Helper',
      runId: 'parent-turn-1',
      workerId: 'sub_A',
      childConversationId: 'sub_A',
      parentConversationId: parent.id,
      parentTurnId: 'parent-turn-1',
      role: 'scout',
      brief: 'survey the repo',
      model: 'test/model',
      workspace: '/repo',
      tools: ['read', 'bash'],
      mcpTools: ['github__pr'],
      spawnableTypes: undefined,
      canSpawn: undefined,
      subagentType: 'general-purpose',
      description: 'survey repo',
      name: 'scout',
      systemPrompt: 'the definition body',
      background: false,
      oneShot: false,
      skipMemory: undefined,
      maxTurns: undefined,
      depth: 1,
    });
  });

  /**
   * The central security property of the whole task: a grant is persisted at
   * spawn time, and the parent's own grant can SHRINK before the child is
   * resumed. The rebuild is intersected with what the parent holds NOW, never
   * with what it held then.
   */
  it('re-intersects the stored grant against the parent agent CURRENT tools', () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_A');
    // The operator took `bash` away from the agent after the child ran.
    agents.set(AGENT_ID, config({ tools: ['read', 'mcp'] }));

    expect(reconstructChildSpec('sub_A', deps())?.tools).toEqual(['read']);
  });

  it('re-intersects the stored MCP grant against what the agent holds NOW', () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_A');
    agentMcp = ['github__merge'];

    expect(reconstructChildSpec('sub_A', deps())?.mcpTools).toEqual([]);
  });

  it('bounds a GRANDCHILD by its parent child, not by the top-level agent', () => {
    const parent = parentConversation();
    // The middle child kept only `read`, though the agent still holds `bash`.
    persistChild(parent.id, 'sub_MID', { tools: ['read'], mcpTools: [] });
    persistChild('sub_MID', 'sub_GRAND', {
      tools: ['read', 'bash'],
      mcpTools: ['github__pr'],
      depth: 2,
    });

    const rebuilt = reconstructChildSpec('sub_GRAND', deps());
    expect(rebuilt?.tools).toEqual(['read']);
    expect(rebuilt?.mcpTools).toEqual([]);
  });

  it('prefers the LIVE spec of a parent that is still running', () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_MID', { tools: ['read', 'bash'] });
    persistChild('sub_MID', 'sub_GRAND', { tools: ['read', 'bash'], depth: 2 });
    // The middle child is mid-turn and its live grant is narrower than the row.
    const live = { ...specFor('sub_MID', parent.id), tools: ['read'], mcpTools: [] } as ChildSpec;

    const rebuilt = reconstructChildSpec(
      'sub_GRAND',
      deps({ liveSpec: (id) => (id === 'sub_MID' ? live : undefined) }),
    );
    expect(rebuilt?.tools).toEqual(['read']);
  });

  it('refuses when the agent is gone, the grant is missing, or the row is not a child', () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_A');
    persistChild(parent.id, 'sub_NOGRANT');
    // Wipe the grant the way a row written before this feature has none.
    conversations.putSubagentGrant('sub_NOGRANT', undefined);

    expect(reconstructChildSpec('sub_NOGRANT', deps())).toBeUndefined();
    expect(reconstructChildSpec(parent.id, deps())).toBeUndefined();
    expect(reconstructChildSpec('sub_MISSING', deps())).toBeUndefined();
    expect(reconstructChildSpec('sub_A', deps({ agentConfig: () => undefined }))).toBeUndefined();
  });
});

describe('childAttachOverrides', () => {
  const spec = { ...specFor('sub_A', 'convo-1'), model: 'child/model' };

  it('gives a child turn its OWN model, tools, MCP grant and workspace', () => {
    expect(childAttachOverrides(spec)).toMatchObject({
      orchestratorModel: 'child/model',
      orchestratorTools: ['read', 'bash'],
      orchestratorMcpTools: ['github__pr'],
      workspace: '/repo',
    });
  });

  /**
   * Ruling 6: the agent-level `subagents.allowedModels` is an operator grant to
   * the TOP-LEVEL agent, not an inheritance a child earned — clearing the
   * fallback chain while leaving it in force let a grandchild spawn on any
   * model in the agent's allow-list.
   */
  it('clears the agent fallback chain AND the agent model allow-list', () => {
    const overrides = childAttachOverrides(spec);
    expect('orchestratorFallbackModels' in overrides).toBe(true);
    expect(overrides.orchestratorFallbackModels).toBeUndefined();
    expect('allowedModels' in overrides).toBe(true);
    expect(overrides.allowedModels).toBeUndefined();
  });

  it('sends an EMPTY MCP list for a child with no MCP grant (unset would inherit)', () => {
    const overrides = childAttachOverrides({ ...spec, mcpTools: undefined });
    expect(overrides.orchestratorMcpTools).toEqual([]);
  });
});

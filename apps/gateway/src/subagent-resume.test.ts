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
        ...(spec.isolation !== undefined ? { isolation: spec.isolation } : {}),
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

  it("puts a grandchild inside a LIVE isolated parent's worktree, not the repo", () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_MID', { isolation: 'worktree' });
    persistChild('sub_MID', 'sub_GRAND', { depth: 2, workspace: '/repo-old' });
    // The middle child is mid-turn: its LIVE spec still names the repo, because
    // its worktree is minted by the runtime after the spec is built.
    const live = {
      ...specFor('sub_MID', parent.id),
      isolation: 'worktree' as const,
      workspace: '/repo',
    } as ChildSpec;

    const rebuilt = reconstructChildSpec(
      'sub_GRAND',
      deps({
        liveSpec: (id) => (id === 'sub_MID' ? live : undefined),
        worktreePath: (s) => `/data/worktrees/${s.agentName}/${s.workerId}`,
      }),
    );
    expect(rebuilt?.workspace).toBe('/data/worktrees/Helper/sub_MID');
  });

  it('prefers the LIVE spec of a parent that is still running', () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_MID', { tools: ['read', 'bash'] });
    persistChild('sub_MID', 'sub_GRAND', { tools: ['read', 'bash'], depth: 2 });
    // The middle child is mid-turn and its live grant is narrower than the row.
    const live: ChildSpec = {
      ...specFor('sub_MID', parent.id),
      tools: ['read'],
      mcpTools: [],
      extraTools: [],
    };

    const rebuilt = reconstructChildSpec(
      'sub_GRAND',
      deps({ liveSpec: (id) => (id === 'sub_MID' ? live : undefined) }),
    );
    expect(rebuilt?.tools).toEqual(['read']);
  });

  /**
   * Review item 2: `workspace` is a grant field like any other. An agent whose
   * workspace moved must not resume a child — or let it spawn a grandchild —
   * pointed at the directory it used to have.
   */
  it("rebinds a non-isolated child to the agent's CURRENT workspace", () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_A', { workspace: '/repo-old' });
    agents.set(AGENT_ID, config({ tools: agentTools, workspace: '/repo-new' }));

    expect(reconstructChildSpec('sub_A', deps())?.workspace).toBe('/repo-new');
  });

  it('keeps an ISOLATED child in its own worktree, not the agent workspace', () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_A', { isolation: 'worktree' });
    conversations.updateSubagent('sub_A', {
      info: { workspace: '/data/worktrees/Helper/sub_A' },
    });
    agents.set(AGENT_ID, config({ tools: agentTools, workspace: '/repo-new' }));

    const rebuilt = reconstructChildSpec('sub_A', deps());
    expect(rebuilt?.workspace).toBe('/data/worktrees/Helper/sub_A');
    expect(rebuilt?.isolation).toBe('worktree');
  });

  it("puts a grandchild inside its parent child's worktree, not the agent workspace", () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_MID', { isolation: 'worktree' });
    conversations.updateSubagent('sub_MID', {
      info: { workspace: '/data/worktrees/Helper/sub_MID' },
    });
    persistChild('sub_MID', 'sub_GRAND', { depth: 2, workspace: '/repo-old' });
    agents.set(AGENT_ID, config({ tools: agentTools, workspace: '/repo-new' }));

    expect(reconstructChildSpec('sub_GRAND', deps())?.workspace).toBe(
      '/data/worktrees/Helper/sub_MID',
    );
  });

  /**
   * Round 2, item 2. `workspace` and the repo a worktree is CUT FROM are two
   * different directories for a resumed isolated child: its `workspace` is
   * already its own worktree path, and `git worktree add` has to run in the
   * repo. Passing the worktree path as the repo is why a resumed isolated
   * child whose worktree had been cleaned up died with WORKTREE_REQUIRES_GIT.
   */
  it("hands back the REPO an isolated child's worktree is cut from, not its worktree", () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_A', { isolation: 'worktree' });
    conversations.updateSubagent('sub_A', {
      info: { workspace: '/data/worktrees/Helper/sub_A' },
    });
    agents.set(AGENT_ID, config({ tools: agentTools, workspace: '/repo-new' }));

    const rebuilt = reconstructChildSpec('sub_A', deps());
    expect(rebuilt?.workspace).toBe('/data/worktrees/Helper/sub_A');
    expect(rebuilt?.isolationSource).toBe('/repo-new');
  });

  it('falls back to the persisted repo when the agent config names no workspace', () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_A', { isolation: 'worktree', workspace: '/repo' });
    conversations.updateSubagent('sub_A', {
      info: { workspace: '/data/worktrees/Helper/sub_A' },
    });
    // No `workspace` on the agent: the coordinator fell back to process.cwd()
    // at spawn, and the grant recorded the repo the child was actually cut from.
    agents.set(AGENT_ID, config({ tools: agentTools }));

    expect(reconstructChildSpec('sub_A', deps())?.isolationSource).toBe('/repo');
  });

  it('leaves isolationSource unset for a child that was never isolated', () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_A');
    expect(reconstructChildSpec('sub_A', deps())?.isolationSource).toBeUndefined();
  });

  /** Review item 5: the operator's off switch has to reach a resumable child. */
  it('refuses to rebuild once the operator turns sub-agents off', () => {
    const parent = parentConversation();
    persistChild(parent.id, 'sub_A');
    expect(reconstructChildSpec('sub_A', deps())).toBeDefined();

    agents.set(AGENT_ID, config({ tools: agentTools, subagents: { enabled: false } }));

    expect(reconstructChildSpec('sub_A', deps())).toBeUndefined();
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

  it('REFUSES a grandchild whose MIDDLE ancestor has no grant — the level is not skipped', () => {
    const parent = parentConversation();
    // A middle child narrowed to `read`, and a grandchild under it that was
    // granted `read` and `bash` while the middle child still held both.
    persistChild(parent.id, 'sub_MID', { tools: ['read'], mcpTools: [] });
    persistChild('sub_MID', 'sub_LEAF', { tools: ['read', 'bash'], depth: 2 });
    // The middle row loses its grant. This state is reachable, not hypothetical.
    conversations.putSubagentGrant('sub_MID', undefined);

    // `undefined` means "cannot be established", which is a REFUSAL and not an
    // empty grant. The natural wrong implementation — walk on to the
    // grandparent when a level has no grant — passed the whole suite, and in
    // production it intersects this leaf against the ROOT agent instead of
    // against the child that spawned it, so the leaf keeps `bash`: a tool its
    // own parent did not hold. That is the invariant this branch exists for.
    expect(reconstructChildSpec('sub_LEAF', deps())).toBeUndefined();
    // The sibling case: the same refusal one level down is already pinned.
    expect(reconstructChildSpec('sub_MID', deps())).toBeUndefined();
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

  /**
   * Round 2 observation: a LIVE isolated child's spec still carries the PARENT's
   * repo as its workspace (the worktree is minted later, by the runtime), so a
   * grandchild spawned during its turn was sandboxed in the repo its parent was
   * isolated FROM. The worktree path is deterministic, so the overrides can
   * name it before it exists.
   */
  it("sandboxes a grandchild in the isolated parent's worktree, not the repo", () => {
    const live = { ...spec, isolation: 'worktree' as const, workspace: '/repo' };
    const overrides = childAttachOverrides(
      live,
      (s) => `/data/worktrees/${s.agentName}/${s.workerId}`,
    );
    expect(overrides.workspace).toBe('/data/worktrees/Helper/sub_A');
  });

  it('leaves a non-isolated child in its own workspace', () => {
    expect(childAttachOverrides(spec, () => '/never').workspace).toBe('/repo');
  });

  it('sends an EMPTY MCP list for a child with no MCP grant (unset would inherit)', () => {
    const overrides = childAttachOverrides({ ...spec, mcpTools: undefined });
    expect(overrides.orchestratorMcpTools).toEqual([]);
  });
});

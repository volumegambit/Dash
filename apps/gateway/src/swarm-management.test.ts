import type { AgentEvent } from '@dash/agent';
import {
  type SwarmAttachment,
  SwarmCoordinator,
  type WorkerBackend,
  type WorkerSpec,
} from '@dash/swarm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import type { AgentRegistry } from './agent-registry.js';
import type { RegisteredAgent } from './agent-registry.js';
import type { ChannelRegistry, RegisteredChannel } from './channel-registry.js';
import type { GatewayCredentialStore } from './credential-store.js';
import { EventBus } from './event-bus.js';
import type { DynamicGateway } from './gateway.js';
import { createGatewayManagementApp } from './management-api.js';

// --- Mock factories (mirrors management-api-server.test.ts) ---

let agentIdCounter = 0;

function makeAgentRegistry(): AgentRegistry {
  const agents = new Map<string, RegisteredAgent>();
  return {
    register: vi.fn((config) => {
      const id = `a${++agentIdCounter}`;
      const entry: RegisteredAgent = {
        id,
        name: config.name,
        config,
        status: 'registered',
        registeredAt: new Date().toISOString(),
      };
      agents.set(id, entry);
      return entry;
    }),
    get: vi.fn((id: string) => agents.get(id)),
    findByName: vi.fn((name: string) => [...agents.values()].find((a) => a.name === name)),
    list: vi.fn(() => [...agents.values()]),
    update: vi.fn((id: string, patch: Record<string, unknown>) => {
      const entry = agents.get(id);
      if (!entry) throw new Error(`Agent '${id}' not found`);
      entry.config = { ...entry.config, ...patch };
      return entry;
    }),
    remove: vi.fn((id: string) => agents.delete(id)),
    disable: vi.fn((id: string) => {
      const entry = agents.get(id);
      if (!entry) throw new Error(`Agent '${id}' not found`);
      entry.status = 'disabled';
    }),
    enable: vi.fn((id: string) => {
      const entry = agents.get(id);
      if (!entry) throw new Error(`Agent '${id}' not found`);
      entry.status = 'registered';
    }),
    setActive: vi.fn(),
    has: vi.fn((id: string) => agents.has(id)),
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentRegistry;
}

function makeChannelRegistry(): ChannelRegistry {
  const channels = new Map<string, RegisteredChannel>();
  return {
    register: vi.fn((config) => {
      const entry: RegisteredChannel = {
        name: config.name,
        adapter: config.adapter,
        globalDenyList: config.globalDenyList,
        allowedUsers: config.allowedUsers ?? [],
        routing: config.routing,
        registeredAt: new Date().toISOString(),
      };
      channels.set(config.name, entry);
      return entry;
    }),
    get: vi.fn((name: string) => channels.get(name)),
    list: vi.fn(() => [...channels.values()]),
    update: vi.fn((name: string) => channels.get(name)),
    remove: vi.fn((name: string) => channels.delete(name)),
    removeRoutesForAgent: vi.fn(() => []),
    has: vi.fn((name: string) => channels.has(name)),
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChannelRegistry;
}

function makeCredentialStore(): GatewayCredentialStore {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    list: vi.fn(() => Promise.resolve([...store.keys()])),
    readProviderApiKeys: vi.fn(() => Promise.resolve({})),
    init: vi.fn().mockResolvedValue(undefined),
  } as unknown as GatewayCredentialStore;
}

function makeGateway(): DynamicGateway {
  return {
    registerAgent: vi.fn(),
    deregisterAgent: vi.fn().mockResolvedValue([]),
    registerChannel: vi.fn().mockResolvedValue(undefined),
    stopChannel: vi.fn().mockResolvedValue(true),
    agentCount: vi.fn().mockReturnValue(0),
    channelCount: vi.fn().mockReturnValue(0),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAgents(): AgentChatCoordinator {
  return {
    chat: vi.fn(),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    answerQuestion: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockReturnValue(false),
    evict: vi.fn().mockResolvedValue(undefined),
    evictAll: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue([]),
    getSkill: vi.fn().mockResolvedValue(null),
    createSkill: vi.fn().mockResolvedValue({ name: 'x', location: '/x/SKILL.md' }),
    updateSkillContent: vi.fn().mockResolvedValue({ name: 'x', location: '/x/SKILL.md' }),
    installSkill: vi.fn().mockResolvedValue({
      name: 'x',
      location: '/x/SKILL.md',
      verdict: { verdict: 'safe', reasons: [] },
    }),
    removeSkill: vi.fn().mockResolvedValue({ name: 'x' }),
    stats: vi.fn().mockReturnValue({ size: 0, maxSize: 0, pinned: 0, agents: {} }),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentChatCoordinator;
}

function makeModelsStore() {
  return {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('./models-store.js').ModelsStore;
}

// --- Controllable fake worker backend ---
//
// A worker's status is driven by its WorkerBackend generator. We hand the test
// a `finish()` trigger so it can leave a worker "running" (never yields, never
// returns) until it chooses to terminate it (generator returns → done).
interface FakeWorker {
  backend: WorkerBackend;
  finish(): void;
}

function makeFakeWorkerFactory() {
  const workers: FakeWorker[] = [];
  const factory = vi.fn((_spec: WorkerSpec): Promise<WorkerBackend> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: WorkerBackend = {
      async *chat(): AsyncGenerator<AgentEvent> {
        // Stay "running" until the test releases the gate, then return (→ done).
        // `yield*` over an empty array satisfies the generator contract (and the
        // useYield lint) without ever emitting an event.
        await gate;
        yield* [] as AgentEvent[];
      },
      abort() {},
      stop() {
        return Promise.resolve();
      },
    };
    workers.push({ backend, finish: release });
    return Promise.resolve(backend);
  });
  return { factory, workers };
}

function createApp(overrides: Record<string, unknown> = {}) {
  const deps = {
    gateway: makeGateway(),
    agents: makeAgents(),
    agentRegistry: makeAgentRegistry(),
    channelRegistry: makeChannelRegistry(),
    credentialStore: makeCredentialStore(),
    modelsStore: makeModelsStore(),
    startedAt: '2026-04-03T00:00:00Z',
    token: 'test-token',
    ...overrides,
  };
  const app = createGatewayManagementApp(deps);
  return { app, ...deps };
}

const AUTH = { Authorization: 'Bearer test-token' };
const JSON_HEADERS = { 'Content-Type': 'application/json', ...AUTH };
const MODEL = 'anthropic/claude-sonnet-4-20250514';

/** Register an agent in a mock registry and return its id. */
function registerAgent(agentRegistry: AgentRegistry, extra: Record<string, unknown> = {}): string {
  const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
    name: `orch-${Math.random().toString(36).slice(2, 6)}`,
    model: MODEL,
    systemPrompt: 'p',
    ...extra,
  });
  return entry.id;
}

/**
 * Attach a live turn and spawn one worker so a real run exists. Returns the
 * attachment (for finalize), the runId, and the spawned worker id.
 */
function spawnRun(
  coordinator: SwarmCoordinator,
  agentId: string,
  conversationId = 'conv-1',
): { attachment: SwarmAttachment; runId: string; workerId: string } {
  const attachment = coordinator.attach({
    agentId,
    agentName: 'orch',
    conversationId,
    orchestratorModel: MODEL,
  });
  const { workerId } = coordinator.spawnWorker(agentId, conversationId, {
    role: 'Scout',
    brief: 'do a thing',
  });
  const runs = coordinator.getRuns(agentId);
  const runId = runs[0].runId;
  return { attachment, runId, workerId };
}

describe('swarm management routes', () => {
  let coordinator: SwarmCoordinator;
  let workers: ReturnType<typeof makeFakeWorkerFactory>['workers'];

  beforeEach(() => {
    agentIdCounter = 0;
    const fake = makeFakeWorkerFactory();
    workers = fake.workers;
    coordinator = new SwarmCoordinator({ workerFactory: fake.factory });
  });

  afterEach(() => {
    coordinator.stop();
  });

  // --- Auth inheritance: 401 without bearer on every new route ---
  describe('auth inheritance', () => {
    it('401s every swarm route without a bearer token', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const paths: Array<{ path: string; method: string }> = [
        { path: `/agents/${id}/swarm/runs`, method: 'GET' },
        { path: `/agents/${id}/swarm/runs/r1`, method: 'GET' },
        { path: `/agents/${id}/swarm/runs/r1/workers/w1/cancel`, method: 'POST' },
        { path: `/agents/${id}/swarm/runs/r1/workers/w1/send`, method: 'POST' },
      ];
      for (const { path, method } of paths) {
        const res = await app.request(path, { method });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    });
  });

  // --- Behavior 1: GET runs ---
  describe('GET /agents/:id/swarm/runs', () => {
    it('returns the run summaries for the agent', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const { runId } = spawnRun(coordinator, id);

      const res = await app.request(`/agents/${id}/swarm/runs`, { headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.runs)).toBe(true);
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0].runId).toBe(runId);
      expect(body.runs[0].agentId).toBe(id);
    });

    it('returns an empty runs array when the agent has no runs', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const res = await app.request(`/agents/${id}/swarm/runs`, { headers: AUTH });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ runs: [] });
    });

    it('404s for an unknown agent', async () => {
      const { app } = createApp({ swarmCoordinator: coordinator });
      const res = await app.request('/agents/ghost/swarm/runs', { headers: AUTH });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    });
  });

  // --- Behavior 2: GET run snapshot ---
  describe('GET /agents/:id/swarm/runs/:runId', () => {
    it('returns the run snapshot with workers', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const { runId, workerId } = spawnRun(coordinator, id);

      const res = await app.request(`/agents/${id}/swarm/runs/${runId}`, { headers: AUTH });
      expect(res.status).toBe(200);
      const snap = await res.json();
      expect(snap.runId).toBe(runId);
      expect(snap.workers).toHaveLength(1);
      expect(snap.workers[0].workerId).toBe(workerId);
    });

    it('404s for an unknown agent', async () => {
      const { app } = createApp({ swarmCoordinator: coordinator });
      const res = await app.request('/agents/ghost/swarm/runs/r1', { headers: AUTH });
      expect(res.status).toBe(404);
    });

    it('404s for an unknown run', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const res = await app.request(`/agents/${id}/swarm/runs/nope`, { headers: AUTH });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    });
  });

  // --- Behavior 3: cancel worker ---
  describe('POST /agents/:id/conversations/:conversationId/swarm/cancel', () => {
    it('terminalizes the live turn → {cancelled:true}, then idempotently false', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      spawnRun(coordinator, id, 'conv-cancel');

      const res = await app.request(`/agents/${id}/conversations/conv-cancel/swarm/cancel`, {
        method: 'POST',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cancelled: true });
      // The turn is finalized: spawning again for the same conversation throws.
      expect(() => coordinator.spawnWorker(id, 'conv-cancel', { role: 'r', brief: 'b' })).toThrow();

      const again = await app.request(`/agents/${id}/conversations/conv-cancel/swarm/cancel`, {
        method: 'POST',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      expect(await again.json()).toEqual({ cancelled: false });
    });

    it('returns {cancelled:false} when the conversation has no live turn', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const res = await app.request(`/agents/${id}/conversations/never-ran/swarm/cancel`, {
        method: 'POST',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cancelled: false });
    });

    it('404s for an unknown agent', async () => {
      const { app } = createApp({ swarmCoordinator: coordinator });
      const res = await app.request('/agents/ghost/conversations/c1/swarm/cancel', {
        method: 'POST',
        headers: AUTH,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /agents/:id/swarm/runs/:runId/workers/:workerId/cancel', () => {
    it('cancels a live worker → {ok:true}', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const { runId, workerId } = spawnRun(coordinator, id);

      const res = await app.request(
        `/agents/${id}/swarm/runs/${runId}/workers/${workerId}/cancel`,
        { method: 'POST', headers: AUTH },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it('404s for an unknown agent', async () => {
      const { app } = createApp({ swarmCoordinator: coordinator });
      const res = await app.request('/agents/ghost/swarm/runs/r1/workers/w1/cancel', {
        method: 'POST',
        headers: AUTH,
      });
      expect(res.status).toBe(404);
    });

    it('409s when the run is finalized', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const { attachment, runId, workerId } = spawnRun(coordinator, id);
      // Finalize the run: it moves to history and is no longer a LIVE run.
      attachment.finalize({ consumerAlive: true });

      const res = await app.request(
        `/agents/${id}/swarm/runs/${runId}/workers/${workerId}/cancel`,
        { method: 'POST', headers: AUTH },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe('run finalized');
    });

    it('409s when the worker is already terminal', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const { runId, workerId } = spawnRun(coordinator, id);
      // Drive the worker to done (generator returns), but keep the run live.
      workers[0].finish();
      // Let the worker's terminal transition flush.
      await new Promise((r) => setTimeout(r, 5));

      const res = await app.request(
        `/agents/${id}/swarm/runs/${runId}/workers/${workerId}/cancel`,
        { method: 'POST', headers: AUTH },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe('worker terminal');
    });
  });

  // --- Behavior 4: send panel message ---
  describe('POST /agents/:id/swarm/runs/:runId/workers/:workerId/send', () => {
    it('sends a steer to a live worker → {ok:true}', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const { runId, workerId } = spawnRun(coordinator, id);

      const res = await app.request(`/agents/${id}/swarm/runs/${runId}/workers/${workerId}/send`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ message: 'refocus on X' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it('400s on a missing message', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const { runId, workerId } = spawnRun(coordinator, id);
      const res = await app.request(`/agents/${id}/swarm/runs/${runId}/workers/${workerId}/send`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('400s on an empty message', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const { runId, workerId } = spawnRun(coordinator, id);
      const res = await app.request(`/agents/${id}/swarm/runs/${runId}/workers/${workerId}/send`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ message: '   ' }),
      });
      expect(res.status).toBe(400);
    });

    it('404s for an unknown agent', async () => {
      const { app } = createApp({ swarmCoordinator: coordinator });
      const res = await app.request('/agents/ghost/swarm/runs/r1/workers/w1/send', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ message: 'hi' }),
      });
      expect(res.status).toBe(404);
    });

    it('409s when the run is finalized', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const { attachment, runId, workerId } = spawnRun(coordinator, id);
      attachment.finalize({ consumerAlive: true });

      const res = await app.request(`/agents/${id}/swarm/runs/${runId}/workers/${workerId}/send`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ message: 'hi' }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe('run finalized');
    });

    it('409s when the worker is already terminal', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const id = registerAgent(agentRegistry);
      const { runId, workerId } = spawnRun(coordinator, id);
      workers[0].finish();
      await new Promise((r) => setTimeout(r, 5));

      const res = await app.request(`/agents/${id}/swarm/runs/${runId}/workers/${workerId}/send`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ message: 'hi' }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).reason).toBe('worker terminal');
    });
  });

  // --- Absent coordinator: routes not mounted, existing app still constructs ---
  describe('without swarmCoordinator', () => {
    it('404s the swarm routes (route not mounted) but the app still works', async () => {
      const { app, agentRegistry } = createApp(); // no swarmCoordinator
      const id = registerAgent(agentRegistry);
      const res = await app.request(`/agents/${id}/swarm/runs`, { headers: AUTH });
      expect(res.status).toBe(404);
      // A normal route still works.
      const ok = await app.request('/agents', { headers: AUTH });
      expect(ok.status).toBe(200);
    });
  });
});

// --- Behavior 5: EventBus poke event + throttle wiring ---
describe('swarm:run-changed EventBus event + throttle', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throttles two rapid onRunChanged calls to a single emit per run per 1s', () => {
    vi.useFakeTimers();
    const eventBus = new EventBus();
    const events: unknown[] = [];
    eventBus.subscribe((e) => events.push(e));

    // Mirror the index.ts wiring: a per-runId last-emit map, throttled to 1/s.
    const lastEmit = new Map<string, number>();
    const THROTTLE_MS = 1000;
    const onRunChanged = (agentId: string, runId: string) => {
      const now = Date.now();
      const prev = lastEmit.get(runId);
      if (prev !== undefined && now - prev < THROTTLE_MS) return;
      lastEmit.set(runId, now);
      eventBus.emit({ type: 'swarm:run-changed', agentId, runId });
    };

    onRunChanged('a1', 'run-1');
    onRunChanged('a1', 'run-1'); // within 1s → suppressed
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'swarm:run-changed', agentId: 'a1', runId: 'run-1' });

    // After the window elapses, the next poke emits again.
    vi.advanceTimersByTime(1001);
    onRunChanged('a1', 'run-1');
    expect(events).toHaveLength(2);
  });

  it('the GatewayEvent union carries swarm:run-changed (type check)', () => {
    const eventBus = new EventBus();
    const seen: unknown[] = [];
    eventBus.subscribe((e) => seen.push(e));
    eventBus.emit({ type: 'swarm:run-changed', agentId: 'a1', runId: 'r1' });
    expect(seen).toEqual([{ type: 'swarm:run-changed', agentId: 'a1', runId: 'r1' }]);
  });
});

// --- Behaviors 6-8: lifecycle cascades ---
describe('lifecycle cascades', () => {
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    agentIdCounter = 0;
    const fake = makeFakeWorkerFactory();
    coordinator = new SwarmCoordinator({ workerFactory: fake.factory });
  });

  afterEach(() => {
    coordinator.stop();
  });

  // Behavior 6: PUT eviction on swarm change.
  describe('PUT /agents/:id evicts on a swarm-config change', () => {
    it('evicts when the swarm block changed', async () => {
      const { app, agentRegistry, agents } = createApp({ swarmCoordinator: coordinator });
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'x',
        model: MODEL,
        systemPrompt: 'p',
        swarm: { enabled: false },
      });
      const res = await app.request(`/agents/${entry.id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ swarm: { enabled: true } }),
      });
      expect(res.status).toBe(200);
      expect(agents.evict).toHaveBeenCalledWith(entry.id);
    });

    it('does NOT evict when the swarm block is unchanged', async () => {
      const { app, agentRegistry, agents } = createApp({ swarmCoordinator: coordinator });
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'x',
        model: MODEL,
        systemPrompt: 'p',
        swarm: { enabled: true },
      });
      const res = await app.request(`/agents/${entry.id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ model: 'gpt-4' }),
      });
      expect(res.status).toBe(200);
      expect(agents.evict).not.toHaveBeenCalled();
    });
  });

  // Behavior 7: disable cascade.
  describe('POST /agents/:id/disable cascades to the coordinator + eviction', () => {
    it('cancels runs for the agent and evicts warm backends', async () => {
      const { app, agentRegistry, agents } = createApp({ swarmCoordinator: coordinator });
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'x',
        model: MODEL,
        systemPrompt: 'p',
      });
      const cancelSpy = vi.spyOn(coordinator, 'cancelRunsFor');
      const res = await app.request(`/agents/${entry.id}/disable`, {
        method: 'POST',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      expect(agentRegistry.disable).toHaveBeenCalledWith(entry.id);
      expect(cancelSpy).toHaveBeenCalledWith(entry.id);
      expect(agents.evict).toHaveBeenCalledWith(entry.id);
    });

    it('actually finalizes a live run for the disabled agent', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'x',
        model: MODEL,
        systemPrompt: 'p',
      });
      // Start a live run so the cascade has something to finalize.
      coordinator.attach({
        agentId: entry.id,
        agentName: 'x',
        conversationId: 'c1',
        orchestratorModel: MODEL,
      });
      coordinator.spawnWorker(entry.id, 'c1', { role: 'Scout', brief: 'b' });
      expect(coordinator.getRuns(entry.id).some((r) => !r.finalized)).toBe(true);

      const res = await app.request(`/agents/${entry.id}/disable`, {
        method: 'POST',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      // After disable the run is finalized (in history, not live).
      expect(coordinator.getRuns(entry.id).every((r) => r.finalized)).toBe(true);
    });
  });

  // Behavior 8: DELETE cascade.
  describe('DELETE /agents/:id cascades to the coordinator', () => {
    it('cancels runs for the agent', async () => {
      const { app, agentRegistry } = createApp({ swarmCoordinator: coordinator });
      const entry = (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'x',
        model: MODEL,
        systemPrompt: 'p',
      });
      const cancelSpy = vi.spyOn(coordinator, 'cancelRunsFor');
      const res = await app.request(`/agents/${entry.id}`, { method: 'DELETE', headers: AUTH });
      expect(res.status).toBe(200);
      expect(cancelSpy).toHaveBeenCalledWith(entry.id);
    });
  });
});

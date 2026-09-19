import type { ProviderCatalog } from '@dash/plugin-sdk';
import {
  applyOpenRouterAudit,
  auditOpenRouter,
  fetchOpenRouterSnapshot,
} from './openrouter-audit.js';

const catalog = {
  id: 'openrouter',
  models: [],
  supportedPatterns: [],
} as unknown as ProviderCatalog;
function model(id: string, created = 100) {
  return {
    id,
    name: id,
    created,
    context_length: 131072,
    top_provider: { max_completion_tokens: 8192 },
    supported_parameters: ['tools', 'reasoning'],
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    pricing: { prompt: '0.000002', completion: '0.000006' },
  };
}

it('finds future successors by reviewed family and keeps distinct capability/cost tiers', () => {
  const report = auditOpenRouter(catalog, {
    data: [
      model('z-ai/glm-5.3'),
      model('z-ai/glm-6', 200),
      model('z-ai/glm-6-flash', 201),
      model('openai/gpt-7-astra', 200),
      model('openai/gpt-5.6-luna', 150),
      model('deepseek/deepseek-v5-pro'),
      model('minimax/minimax-m4'),
    ],
  });
  expect(report.selected.map((m) => m.id)).toEqual(
    expect.arrayContaining([
      'z-ai/glm-6',
      'z-ai/glm-6-flash',
      'openai/gpt-7-astra',
      'openai/gpt-5.6-luna',
      'deepseek/deepseek-v5-pro',
      'minimax/minimax-m4',
    ]),
  );
  expect(report.selected.map((m) => m.id)).not.toContain('z-ai/glm-5.3');
  expect(report.missing).toEqual(report.selected.map((m) => m.id));
});

it('rejects tools-only false positives, variants, experiments, expired and incomplete models', () => {
  const report = auditOpenRouter(catalog, {
    data: [
      model('z-ai/glm-6:free'),
      model('z-ai/glm-6-preview'),
      { ...model('z-ai/glm-7'), supported_parameters: [] },
      {
        ...model('z-ai/glm-8'),
        architecture: { input_modalities: ['text'], output_modalities: ['text', 'image'] },
      },
      { ...model('z-ai/glm-9'), top_provider: { max_completion_tokens: null } },
      { ...model('z-ai/glm-10'), expiration_date: '2020-01-01' },
      { ...model('z-ai/glm-11'), pricing: { prompt: '-1', completion: 'NaN' } },
    ],
  });
  expect(report.selected).toEqual([]);
  expect(report.rejected).toHaveLength(7);
});

it('copies provider metadata without inventing image support, and reports unfamiliar families', () => {
  const report = auditOpenRouter(catalog, {
    data: [
      {
        ...model('z-ai/glm-6'),
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
      model('new-lab/frontier-1'),
    ],
  });
  expect(report.selected[0]).toMatchObject({
    id: 'z-ai/glm-6',
    input: ['text'],
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 2, output: 6 },
  });
  expect(report.reviewCandidates).toEqual(['new-lab/frontier-1']);
});

it('detects missing metadata and allow-list coverage even with a fresh review date', () => {
  const raw = { data: [model('z-ai/glm-6')] };
  const selected = auditOpenRouter(catalog, raw).selected;
  const updated = {
    ...catalog,
    reviewedAt: '2099-01-01',
    models: selected,
    supportedPatterns: [{ pattern: 'z-ai/glm-6', tier: 1 }],
  };
  expect(auditOpenRouter(updated, raw).missing).toEqual([]);
  expect(auditOpenRouter(updated, raw).metadataDrift).toEqual([]);
  updated.models = [{ ...selected[0], input: ['text'] }];
  expect(auditOpenRouter(updated, raw).metadataDrift).toEqual(['z-ai/glm-6']);
});

it('refuses empty, malformed, duplicate or paginated snapshots before applying changes', async () => {
  for (const payload of [
    { data: [] },
    {},
    { data: [model('z-ai/glm-6'), model('z-ai/glm-6')] },
    { data: [model('z-ai/glm-6')], links: { next: 'https://example.test/next' } },
  ]) {
    expect(() => auditOpenRouter(catalog, payload)).toThrow();
  }
  const fetcher = vi.fn().mockResolvedValue(new Response('outage', { status: 503 }));
  await expect(fetchOpenRouterSnapshot(fetcher)).rejects.toThrow('503');
});

it('applies concrete coverage and metadata without deleting compatibility entries or request overrides', () => {
  const legacy = { id: 'legacy/model', contextWindow: 32768, maxTokens: 4096 };
  const original = {
    ...catalog,
    models: [
      legacy,
      { id: 'z-ai/glm-6', contextWindow: 32768, maxTokens: 4096, compat: { special: true } },
    ],
  };
  const report = auditOpenRouter(original, { data: [model('z-ai/glm-6')] });
  const updated = applyOpenRouterAudit(original, report, '2026-09-13');
  expect(updated.models).toContainEqual(legacy);
  expect(updated.models.find((m) => m.id === 'z-ai/glm-6')).toMatchObject({
    contextWindow: 131072,
    compat: { special: true },
  });
  expect(auditOpenRouter(updated, { data: [model('z-ai/glm-6')] }).missing).toEqual([]);
  expect(applyOpenRouterAudit(updated, report, '2026-09-13')).toEqual(updated);
  expect(() =>
    applyOpenRouterAudit({ ...original, excludedPatterns: ['z-ai/*'] }, report, '2026-09-13'),
  ).toThrow('deny-list conflict');
});

it('blocks truncated snapshots and loss of a previously represented family', () => {
  expect(() => auditOpenRouter(catalog, { data: [model('z-ai/glm-6')], total_count: 445 })).toThrow(
    'complete',
  );
  const previous = {
    ...catalog,
    models: [
      { id: 'z-ai/glm-6', contextWindow: 131072, maxTokens: 8192 },
      { id: 'openai/gpt-7-astra', contextWindow: 131072, maxTokens: 8192 },
    ],
  };
  const report = auditOpenRouter(previous, { data: [model('openai/gpt-7-astra')] });
  expect(report.unavailableFamilies).toEqual(['GLM']);
  expect(() => applyOpenRouterAudit(previous, report, '2026-09-13')).toThrow('unavailable');
});

it('requires review when a newly published eligible family is not covered by the policy', () => {
  const report = auditOpenRouter(catalog, { data: [model('new-lab/frontier-2', 1893456000)] });
  expect(report.newFamilyCandidates).toEqual(['new-lab/frontier-2']);
});

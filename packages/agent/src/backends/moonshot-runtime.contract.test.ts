/**
 * Runtime contract for Moonshot (Kimi) model resolution.
 *
 * This is the load-bearing guarantee behind the Dash `moonshotai` provider:
 * discovery surfaces `moonshotai/<id>` values, and at chat time
 * `PiAgentBackend.resolveModel()` resolves them via `getModel('moonshotai', id)`
 * from `@earendil-works/pi-ai`. If a pi-ai upgrade renamed or dropped the
 * `moonshotai` provider key, Moonshot models would still appear in the dropdown
 * but fail at runtime — this test fails loudly instead.
 *
 * It deliberately imports ONLY `@earendil-works/pi-ai` (not `pi-coding-agent`),
 * so it is unaffected by the bundled-undici load issue in
 * `piagent*.test.ts` and stays runnable in any environment.
 */
import { describe, expect, it } from 'vitest';

import { getModel } from '@earendil-works/pi-ai';

describe('Moonshot runtime resolution (pi-ai)', () => {
  // These ids are seeded in @dash/models BOOTSTRAP_MODELS — they MUST resolve
  // or the bootstrap dropdown advertises unrunnable models.
  const bootstrapIds = ['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.5'];

  it.each(bootstrapIds)('getModel("moonshotai", "%s") resolves to a Model with an id', (id) => {
    const model = getModel('moonshotai', id);
    expect(model, id).toBeDefined();
    expect(typeof (model as unknown as { id: string }).id).toBe('string');
  });
});

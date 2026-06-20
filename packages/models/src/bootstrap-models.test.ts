import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_MODELS } from './bootstrap-models.js';
import { isModelSupported } from './supported-models.js';

describe('BOOTSTRAP_MODELS', () => {
  it('uses the canonical "<provider>/<id>" value shape with a matching provider field', () => {
    for (const m of BOOTSTRAP_MODELS) {
      const slash = m.value.indexOf('/');
      expect(slash, m.value).toBeGreaterThan(0);
      expect(m.value.slice(0, slash)).toBe(m.provider);
    }
  });

  // Guards the discovery/runtime dual-namespace trap: a bootstrap entry that
  // isn't allow-listed would be advertised in the no-credentials dropdown yet
  // filtered out (or unrunnable) the moment a credential is added. Every seed
  // must pass the same allow-list every live model is filtered through.
  it.each(BOOTSTRAP_MODELS.map((m) => [m.value, m.provider] as const))(
    'bootstrap entry %s passes isModelSupported',
    (value, provider) => {
      const id = value.slice(value.indexOf('/') + 1);
      expect(isModelSupported(provider, id), value).toBe(true);
    },
  );
});

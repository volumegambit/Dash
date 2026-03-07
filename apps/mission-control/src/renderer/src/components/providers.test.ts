import { PROVIDERS, PROVIDER_CONFIG } from './providers.js';

describe('PROVIDERS', () => {
  it('has at least one available provider', () => {
    const available = PROVIDERS.filter((p) => p.available);
    expect(available.length).toBeGreaterThanOrEqual(1);
  });

  it('every provider has a matching config entry', () => {
    for (const provider of PROVIDERS) {
      expect(PROVIDER_CONFIG[provider.id]).toBeDefined();
    }
  });
});

describe('PROVIDER_CONFIG', () => {
  it('anthropic consoleUrl points to console.anthropic.com', () => {
    expect(PROVIDER_CONFIG.anthropic.consoleUrl).toBe('https://console.anthropic.com');
  });

  it('anthropic apiKeysUrl points to console.anthropic.com/settings/keys', () => {
    expect(PROVIDER_CONFIG.anthropic.apiKeysUrl).toBe(
      'https://console.anthropic.com/settings/keys',
    );
  });

  it('anthropic helpUrl points to Anthropic docs', () => {
    expect(PROVIDER_CONFIG.anthropic.helpUrl).toMatch(/^https:\/\/docs\.anthropic\.com\//);
  });

  it('every provider config has valid URLs', () => {
    for (const [id, config] of Object.entries(PROVIDER_CONFIG)) {
      expect(config.consoleUrl, `${id} consoleUrl`).toMatch(/^https:\/\//);
      expect(config.apiKeysUrl, `${id} apiKeysUrl`).toMatch(/^https:\/\//);
      expect(config.helpUrl, `${id} helpUrl`).toMatch(/^https:\/\//);
    }
  });

  it('every provider config has non-empty required fields', () => {
    for (const [id, config] of Object.entries(PROVIDER_CONFIG)) {
      expect(config.title, `${id} title`).toBeTruthy();
      expect(config.secretKey, `${id} secretKey`).toBeTruthy();
      expect(config.placeholder, `${id} placeholder`).toBeTruthy();
      expect(config.explanation, `${id} explanation`).toBeTruthy();
      expect(config.helpLabel, `${id} helpLabel`).toBeTruthy();
      expect(config.steps.length, `${id} steps`).toBeGreaterThanOrEqual(1);
    }
  });
});

import { AVAILABLE_MODELS, AVAILABLE_TOOLS } from './deploy-options.js';

describe('AVAILABLE_MODELS', () => {
  it('has at least one model', () => {
    expect(AVAILABLE_MODELS.length).toBeGreaterThanOrEqual(1);
  });

  it('every model has a value and label', () => {
    for (const model of AVAILABLE_MODELS) {
      expect(model.value).toBeTruthy();
      expect(model.label).toBeTruthy();
    }
  });

  it('model values are unique', () => {
    const values = AVAILABLE_MODELS.map((m) => m.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('includes claude-sonnet-4 as the default model', () => {
    expect(AVAILABLE_MODELS[0].value).toMatch(/^claude-sonnet-4/);
  });
});

describe('AVAILABLE_TOOLS', () => {
  it('has at least one tool', () => {
    expect(AVAILABLE_TOOLS.length).toBeGreaterThanOrEqual(1);
  });

  it('every tool has a value and label', () => {
    for (const tool of AVAILABLE_TOOLS) {
      expect(tool.value).toBeTruthy();
      expect(tool.label).toBeTruthy();
    }
  });

  it('tool values are unique', () => {
    const values = AVAILABLE_TOOLS.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('tool values use snake_case', () => {
    for (const tool of AVAILABLE_TOOLS) {
      expect(tool.value).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('includes read_file', () => {
    expect(AVAILABLE_TOOLS.some((t) => t.value === 'read_file')).toBe(true);
  });
});

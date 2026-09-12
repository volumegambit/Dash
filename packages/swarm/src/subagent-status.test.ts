import { DEFAULT_SUBAGENT_TYPE } from './subagent-status.js';

describe('subagent-status', () => {
  it('names the type a caller who named none gets', () => {
    expect(DEFAULT_SUBAGENT_TYPE).toBe('general-purpose');
  });
});

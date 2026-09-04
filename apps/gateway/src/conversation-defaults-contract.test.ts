import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONVERSATION_TITLE } from './conversation-service.js';

const fixturesRoot = fileURLToPath(
  new URL('../../../contracts/mobile/v1/fixtures/', import.meta.url),
);

/**
 * Chat UX Phase 4 Task 6: the default conversation title is hand-mirrored by
 * every client (`ChatState.defaultConversationTitle` on iOS, the web store's
 * auto-title check, mission-control) and the Phase 3 fix wave's one real
 * regression came from exactly that drift. The contract fixture
 * (`ConversationDefaults`, `const`-pinned in openapi.yaml) is the single
 * value everyone is tested against; this is the gateway's side of the pin.
 */
describe('conversation defaults contract', () => {
  it('DEFAULT_CONVERSATION_TITLE matches the contract fixture', () => {
    const fixture = JSON.parse(
      readFileSync(join(fixturesRoot, 'conversation-defaults.json'), 'utf8'),
    ) as { defaultConversationTitle: string };
    expect(DEFAULT_CONVERSATION_TITLE).toBe(fixture.defaultConversationTitle);
  });
});

/**
 * A stubbed `window.api` so Mission Control's renderer can run in a plain
 * browser, with no Electron, no main process, no keychain.
 *
 * Why this exists (UI-quality goal, Phase B/C): MC was the only client whose
 * screens had never been looked at. iOS got a capture sweep via `simctl`
 * launch options; web is a normal site. MC's renderer, though, calls
 * `window.api` — the Electron preload IPC bridge — during render, so it
 * cannot be opened in a browser at all, and capturing it otherwise means
 * launching the real desktop app, which reads the user's keychain and opens a
 * window on their screen. Neither is something a capture sweep should need.
 *
 * The preload surface is ~60 methods and grows, so this is a `Proxy` rather
 * than a hand-written double: unknown methods resolve to a benign default
 * instead of throwing, which means adding an IPC method never breaks the
 * harness. Only the calls that need to return something specific for a screen
 * to render are listed in `FIXTURES`.
 *
 * This is a rendering harness, NOT a functional test double. It exists to put
 * pixels on screen for review. Nothing here should be used to assert
 * behaviour — the real IPC contract is covered by the main-process tests.
 */

/** Data specific enough for a screen to render something worth looking at. */
const FIXTURES: Record<string, unknown> = {
  getVersion: '0.2.0-harness',

  // `__root.tsx` gates every route on this: anything other than 'ready' shows
  // the SetupWizard instead of the app, so without it the harness can only
  // ever capture the keychain-consent screen.
  setupStatus: { state: 'ready' },
  gatewayStatus: { running: true, state: 'ready' },

  agentsList: [
    {
      id: 'research-agent',
      name: 'Research Agent',
      status: 'registered',
      // `registeredAt` is REQUIRED by `GatewayAgent` (packages/mc/src/runtime/
      // gateway-client.ts) and the agents table formats it unguarded. Omitting
      // it here rendered "NaNd ago", which looked like a product bug until the
      // type said otherwise — fixtures must satisfy required fields or the
      // harness invents defects that do not exist.
      registeredAt: '2026-08-01T09:00:00Z',
      config: {
        model: 'openai/gpt-5',
        systemPrompt: 'Research carefully',
        tools: ['read', 'search'],
      },
    },
    {
      id: 'sleeping-agent',
      name: 'Sleeping Agent',
      status: 'disabled',
      registeredAt: '2026-09-04T21:30:00Z',
      config: { model: 'anthropic/claude-sonnet-4-5', systemPrompt: 'Rest' },
    },
  ],

  chatListConversations: {
    items: [
      {
        id: 'shared-plan',
        title: 'Shared launch plan',
        agentId: 'research-agent',
        agentName: 'Research Agent',
        status: 'idle',
        updatedAt: new Date('2026-09-05T12:00:00Z').toISOString(),
        lastMessagePreview: 'Saved from your Mac',
      },
    ],
    nextCursor: null,
  },

  credentialsList: [],
  channelsList: [],
  modelsList: { models: [], source: 'live', errors: {} },
  pairingGetInfo: null,
};

/** Methods whose return value is an unsubscribe function, not data. */
function isSubscription(name: string): boolean {
  return name.startsWith('on') || /On[A-Z]/.test(name) || name.endsWith('Subscribe');
}

export function createStubApi(): unknown {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string') return undefined;

        // React and TanStack probe objects for these; returning a function
        // for them makes the proxy look like a thenable and hangs awaits.
        if (property === 'then' || property === 'toJSON') return undefined;

        if (isSubscription(property)) {
          return () => () => {
            /* unsubscribe */
          };
        }

        return async () => {
          if (property in FIXTURES) return FIXTURES[property];
          // Unknown IPC method: resolve rather than throw, so adding one to
          // the preload never breaks the harness. A screen that needs real
          // data from it will render its empty state, which is itself worth
          // capturing.
          return null;
        };
      },
    },
  );
}

/** Installs the stub. Must run before the app's first render. */
export function installStubApi(): void {
  (globalThis as unknown as { api: unknown }).api = createStubApi();
}

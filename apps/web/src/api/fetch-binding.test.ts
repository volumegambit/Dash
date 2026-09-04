import { ControlPlaneClient } from '../auth/control-plane';
// Regression: clients constructed WITHOUT an injected fetchImpl must not
// invoke the global fetch with a rebound `this` — real browsers throw
// "Illegal invocation" for that, which broke every live browser while the
// whole suite (always injecting fakes) stayed green.
import { MobileRestClient } from './rest';

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('default fetch binding', () => {
  const original = globalThis.fetch;
  let observedThis: unknown = 'unset';

  beforeEach(() => {
    observedThis = 'unset';
    globalThis.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      observedThis = this;
      void args;
      return Promise.resolve(okJson({ gateways: [], items: [] }));
    } as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('MobileRestClient default fetch is not invoked as a method of the client', async () => {
    const client = new MobileRestClient('https://gw.example/mobile/v1', {
      getToken: async () => 't',
    });
    await client.health();
    expect(observedThis === undefined || observedThis === globalThis).toBe(true);
  });

  it('ControlPlaneClient default fetch is not invoked as a method of the client', async () => {
    const client = new ControlPlaneClient('https://cp.example', { getToken: async () => 't' });
    await client.listGateways();
    expect(observedThis === undefined || observedThis === globalThis).toBe(true);
  });
});

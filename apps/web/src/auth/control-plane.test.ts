import type { TokenSource } from '../api/rest';
import { ControlPlaneApiError, ControlPlaneClient } from './control-plane';

const TOKEN = 'cp-test-token';

function tokenSource(token = TOKEN): TokenSource {
  return { getToken: () => Promise.resolve(token) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(response: Response | (() => Response)) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    typeof response === 'function' ? response() : response,
  );
}

function authHeader(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

describe('ControlPlaneClient', () => {
  describe('listGateways', () => {
    it('GETs /v1/gateways under the base URL and unwraps { gateways }', async () => {
      const gateways = [
        { gatewayId: 'acme', subdomain: 'acme.relay.example.com', status: 'active', createdAt: 1 },
      ];
      const fetchImpl = fakeFetch(jsonResponse({ gateways }));
      const client = new ControlPlaneClient(
        'https://control.dash.example',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.listGateways()).resolves.toEqual(gateways);
      expect(fetchImpl.mock.calls[0][0]).toBe('https://control.dash.example/v1/gateways');
      expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
    });

    it('sends Authorization: Bearer <token>', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ gateways: [] }));
      const client = new ControlPlaneClient(
        'https://control.dash.example',
        tokenSource(),
        fetchImpl,
      );
      await client.listGateways();
      expect(authHeader(fetchImpl.mock.calls[0][1])).toBe(`Bearer ${TOKEN}`);
    });

    it('joins the base URL without a double slash when baseUrl has a trailing slash', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ gateways: [] }));
      const client = new ControlPlaneClient(
        'https://control.dash.example/',
        tokenSource(),
        fetchImpl,
      );
      await client.listGateways();
      expect(fetchImpl.mock.calls[0][0]).toBe('https://control.dash.example/v1/gateways');
    });
  });

  describe('createWebPairing', () => {
    it('POSTs to the pairing-id-v1 capability route with clientKind: web and the device label', async () => {
      const fetchImpl = fakeFetch(
        jsonResponse({ credential: 'cred-123', pairingId: 'p-1', chatToken: 'chat-abc' }),
      );
      const client = new ControlPlaneClient(
        'https://control.dash.example',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.createWebPairing('acme', 'My Browser')).resolves.toEqual({
        credential: 'cred-123',
        pairingId: 'p-1',
        chatToken: 'chat-abc',
      });

      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://control.dash.example/v1/gateways/acme/pairings/pairing-id-v1');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({
        deviceLabel: 'My Browser',
        clientKind: 'web',
      });
      const headers = init?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('URL-encodes the gatewayId path segment', async () => {
      const fetchImpl = fakeFetch(
        jsonResponse({ credential: 'c', pairingId: 'p', chatToken: 't' }),
      );
      const client = new ControlPlaneClient(
        'https://control.dash.example',
        tokenSource(),
        fetchImpl,
      );
      await client.createWebPairing('gw/with/slash', 'Label');
      const url = fetchImpl.mock.calls[0][0] as string;
      expect(url).toBe(
        'https://control.dash.example/v1/gateways/gw%2Fwith%2Fslash/pairings/pairing-id-v1',
      );
    });

    it('throws ControlPlaneApiError with status 409 when the gateway has no registered chat token', async () => {
      const fetchImpl = fakeFetch(
        jsonResponse({ error: 'no web chat token registered for this gateway' }, 409),
      );
      const client = new ControlPlaneClient(
        'https://control.dash.example',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.createWebPairing('acme', 'My Browser')).rejects.toMatchObject({
        status: 409,
        code: 'no web chat token registered for this gateway',
      });
    });
  });

  describe('listPairings', () => {
    it('GETs /v1/gateways/:id/pairings and unwraps { pairings }', async () => {
      const pairings = [{ id: 'p1', deviceLabel: 'Laptop', clientKind: 'web', status: 'active' }];
      const fetchImpl = fakeFetch(jsonResponse({ pairings }));
      const client = new ControlPlaneClient(
        'https://control.dash.example',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.listPairings('acme')).resolves.toEqual(pairings);
      expect(fetchImpl.mock.calls[0][0]).toBe(
        'https://control.dash.example/v1/gateways/acme/pairings',
      );
      expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
    });

    it('drops revoked pairings — the control plane keeps those rows forever', async () => {
      const fetchImpl = fakeFetch(
        jsonResponse({
          pairings: [
            { id: 'p1', deviceLabel: 'Laptop', clientKind: 'web', status: 'active' },
            { id: 'p2', deviceLabel: 'Old phone', clientKind: 'mobile', status: 'revoked' },
          ],
        }),
      );
      const client = new ControlPlaneClient(
        'https://control.dash.example',
        tokenSource(),
        fetchImpl,
      );

      // A revoked device is dead; listing it would invite "revoke" on a
      // pairing that no longer exists.
      await expect(client.listPairings('acme')).resolves.toEqual([
        { id: 'p1', deviceLabel: 'Laptop', clientKind: 'web', status: 'active' },
      ]);
    });
  });

  describe('deletePairing', () => {
    it('DELETEs /v1/gateways/:id/pairings/:pid', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ ok: true }));
      const client = new ControlPlaneClient(
        'https://control.dash.example',
        tokenSource(),
        fetchImpl,
      );

      await client.deletePairing('acme', 'p1');
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://control.dash.example/v1/gateways/acme/pairings/p1');
      expect(init?.method).toBe('DELETE');
    });
  });

  describe('error handling', () => {
    it('throws ControlPlaneApiError with status and the { error } body field on 404', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ error: 'gateway not found' }, 404));
      const client = new ControlPlaneClient(
        'https://control.dash.example',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.listPairings('missing')).rejects.toMatchObject({
        status: 404,
        code: 'gateway not found',
      });
      await expect(client.listPairings('missing')).rejects.toBeInstanceOf(ControlPlaneApiError);
    });

    it('throws ControlPlaneApiError with status 401 on an auth failure', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ error: 'unauthorized' }, 401));
      const client = new ControlPlaneClient(
        'https://control.dash.example',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.listGateways()).rejects.toMatchObject({ status: 401 });
    });

    it('tolerates a non-JSON error body and still reports the status with an undefined code', async () => {
      const fetchImpl = fakeFetch(new Response('upstream is down', { status: 503 }));
      const client = new ControlPlaneClient(
        'https://control.dash.example',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.listGateways()).rejects.toMatchObject({ status: 503, code: undefined });
    });
  });
});

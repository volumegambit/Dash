import { CatalogFetchError, fetchCatalogModels } from './catalog-fetch.js';

/** Stub fetch returning a canned JSON body and capturing the request. */
function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const ANTHROPIC_SPEC = {
  url: 'https://api.anthropic.com/v1/models',
  auth: [
    {
      whenKeyPrefix: 'sk-ant-oat',
      header: 'authorization',
      valuePrefix: 'Bearer ',
      extraHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
    },
    { header: 'x-api-key' },
  ],
  listPath: 'data',
  idPath: 'id',
  namePath: 'display_name',
};

describe('fetchCatalogModels', () => {
  it('maps an anthropic-shaped response (data[].id/display_name)', async () => {
    const { impl, calls } = stubFetch({
      data: [{ id: 'claude-fable-5', display_name: 'Claude Fable 5' }, { id: 'claude-opus-4-8' }],
    });
    const models = await fetchCatalogModels(
      { id: 'anthropic', modelsFetch: ANTHROPIC_SPEC },
      'sk-ant-api03-xyz',
      impl,
    );
    expect(models).toEqual([
      { id: 'claude-fable-5', label: 'Claude Fable 5' },
      { id: 'claude-opus-4-8', label: 'claude-opus-4-8' },
    ]);
    expect(calls[0]?.headers['x-api-key']).toBe('sk-ant-api03-xyz');
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('applies the first matching auth rule (Anthropic OAuth swap)', async () => {
    const { impl, calls } = stubFetch({ data: [] });
    await fetchCatalogModels(
      { id: 'anthropic', modelsFetch: ANTHROPIC_SPEC },
      'sk-ant-oat01-t',
      impl,
    );
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-ant-oat01-t');
    expect(calls[0]?.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(calls[0]?.headers['x-api-key']).toBeUndefined();
  });

  it('maps a google-shaped response: query-param auth + models/ prefix strip', async () => {
    const { impl, calls } = stubFetch({
      models: [{ name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro' }],
    });
    const models = await fetchCatalogModels(
      {
        id: 'google',
        modelsFetch: {
          url: 'https://generativelanguage.googleapis.com/v1beta/models',
          auth: [{ queryParam: 'key' }],
          listPath: 'models',
          idPath: 'name',
          namePath: 'displayName',
          stripIdPrefix: 'models/',
        },
      },
      'AIza-test',
      impl,
    );
    expect(models).toEqual([{ id: 'gemini-3-pro', label: 'Gemini 3 Pro' }]);
    expect(calls[0]?.url).toContain('key=AIza-test');
  });

  it('maps an openai-shaped response (bearer auth, data[].id, no name field)', async () => {
    const { impl, calls } = stubFetch({ data: [{ id: 'o3-pro' }] });
    const models = await fetchCatalogModels(
      {
        id: 'openai',
        modelsFetch: {
          url: 'https://api.openai.com/v1/models',
          auth: [{ header: 'authorization', valuePrefix: 'Bearer ' }],
          listPath: 'data',
          idPath: 'id',
        },
      },
      'sk-test',
      impl,
    );
    expect(models).toEqual([{ id: 'o3-pro', label: 'o3-pro' }]);
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-test');
  });

  it('resolves nested listPath via dot-paths', async () => {
    const { impl } = stubFetch({ result: { items: [{ model: { slug: 'x-1' } }] } });
    const models = await fetchCatalogModels(
      {
        id: 'nested',
        modelsFetch: {
          url: 'https://api.nested.dev/models',
          auth: [{ header: 'x-api-key' }],
          listPath: 'result.items',
          idPath: 'model.slug',
        },
      },
      'k',
      impl,
    );
    expect(models).toEqual([{ id: 'x-1', label: 'x-1' }]);
  });

  it('throws CatalogFetchError with provider and status on non-2xx', async () => {
    const { impl } = stubFetch({ error: 'nope' }, 401);
    await expect(
      fetchCatalogModels(
        {
          id: 'acme',
          modelsFetch: {
            url: 'https://api.acme.dev/v1/models',
            auth: [{ header: 'x-api-key' }],
            listPath: 'data',
            idPath: 'id',
          },
        },
        'bad-key',
        impl,
      ),
    ).rejects.toMatchObject({ name: 'CatalogFetchError', provider: 'acme', status: 401 });
  });

  it('throws when the catalog has no modelsFetch spec', async () => {
    await expect(fetchCatalogModels({ id: 'static-only' }, 'k')).rejects.toThrow(/modelsFetch/);
  });

  it('skips list entries whose idPath is missing or not a string', async () => {
    const { impl } = stubFetch({ data: [{ id: 'good' }, { nope: 1 }, { id: 42 }] });
    const models = await fetchCatalogModels(
      {
        id: 'acme',
        modelsFetch: {
          url: 'https://api.acme.dev/v1/models',
          auth: [{ header: 'x-api-key' }],
          listPath: 'data',
          idPath: 'id',
        },
      },
      'k',
      impl,
    );
    expect(models).toEqual([{ id: 'good', label: 'good' }]);
  });
});

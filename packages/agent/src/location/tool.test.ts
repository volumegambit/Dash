import { GET_LOCATION_TOOL_NAME, createGetLocationTool } from './tool.js';
import type { ClientLocation } from './types.js';

const coarse: ClientLocation = {
  timezone: 'Asia/Singapore',
  utcOffsetMinutes: 480,
  locale: 'en-SG',
  region: 'SG',
};

function run(location: ClientLocation | undefined | (() => ClientLocation | undefined)) {
  const getter = typeof location === 'function' ? location : () => location;
  return createGetLocationTool(getter).execute('call-1', {});
}

describe('get_location tool', () => {
  it('is named get_location', () => {
    expect(createGetLocationTool(() => coarse).name).toBe(GET_LOCATION_TOOL_NAME);
    expect(GET_LOCATION_TOOL_NAME).toBe('get_location');
  });

  it('reports the coarse tier the client sent for this turn', async () => {
    const result = await run(coarse);
    expect(result.content[0].text).toContain('Asia/Singapore');
    expect(result.content[0].text).toContain('en-SG');
    expect(result.content[0].text).toContain('SG');
    expect(result.details).toMatchObject({ location: coarse });
  });

  it('reports a precise position when the client opted in', async () => {
    const result = await run({
      ...coarse,
      precise: {
        latitude: 1.2966,
        longitude: 103.7764,
        accuracyMeters: 12,
        capturedAt: '2026-09-06T10:11:02Z',
        place: 'National University of Singapore',
      },
    });
    expect(result.content[0].text).toContain('1.2966');
    expect(result.content[0].text).toContain('103.7764');
    expect(result.content[0].text).toContain('National University of Singapore');
    expect(result.content[0].text).toContain('12 m');
  });

  it('says the position is approximate when there is no precise fix', async () => {
    const result = await run(coarse);
    expect(result.content[0].text).toMatch(/approximate|time zone only/i);
    expect(result.content[0].text).not.toContain('accurate to');
  });

  it('reports plainly when the client sent no location, without erroring', async () => {
    const result = await run(undefined);
    expect(result.content[0].text).toMatch(/did not report|no location/i);
    // A missing location is a normal outcome (channel adapters have no client),
    // NOT a tool error -- an error result would push the model to retry.
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(result.details).toMatchObject({ location: null });
  });

  it('reads the getter at call time, so a later turn sees the newer location', async () => {
    let current: ClientLocation | undefined = coarse;
    const tool = createGetLocationTool(() => current);

    const first = await tool.execute('call-1', {});
    expect(first.content[0].text).toContain('Asia/Singapore');

    current = { ...coarse, timezone: 'Pacific/Auckland', utcOffsetMinutes: 720, locale: 'en-NZ' };
    const second = await tool.execute('call-2', {});
    expect(second.content[0].text).toContain('Pacific/Auckland');
  });

  it('never throws when the getter itself throws', async () => {
    const tool = createGetLocationTool(() => {
      throw new Error('backend idle');
    });
    const result = await tool.execute('call-1', {});
    expect(result.content[0].text).toMatch(/no location/i);
  });

  it('takes no parameters', () => {
    const tool = createGetLocationTool(() => coarse);
    expect(tool.parameters).toMatchObject({ type: 'object', properties: {} });
  });
});

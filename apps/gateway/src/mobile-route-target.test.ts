import { classifyMobileRouteTarget } from './mobile-route-target.js';

describe('classifyMobileRouteTarget', () => {
  it.each([
    ['/mobile/v1', 1, '/mobile/v1'],
    ['/mobile/v1/agents?limit=1', 1, '/mobile/v1/agents'],
    ['/mobile/v2', 2, '/mobile/v2'],
    ['/mobile/v2/conversations/id/bootstrap?limit=50', 2, '/mobile/v2/conversations/id/bootstrap'],
  ])('classifies canonical %s as mobile v%s', (target, version, pathname) => {
    expect(classifyMobileRouteTarget(target)).toEqual({ kind: 'mobile', version, pathname });
  });

  it.each(['/agents', '/health', '/mobile/v10', '/mobile/v20', '/mobile/v1evil', '/mobile/v2evil'])(
    'keeps safe non-mobile target %s out of the mobile branch',
    (target) => {
      expect(classifyMobileRouteTarget(target)).toEqual({
        kind: 'non_mobile',
        pathname: target,
      });
    },
  );

  it.each([
    '/mobile/v1/conversations%2Fsecret',
    '/mobile/v1/conversations%252Fsecret',
    '/mobile/v2/conversations%5Csecret',
    '/mobile/v2/conversations%255Csecret',
    '/mobile/v1/%2e%2e/agents',
    '/mobile/v1/%252e%252e/agents',
    '/mobile/v2/../agents',
    '/mobile/v2/%2E%2E/agents',
    '/mobile/v2\\..\\agents',
    '/mobile/v2/health#x',
    '/mobile/v2/health?x#y',
    '/mobile/v2/%',
    '/mobile/v2/%E0%A4%A',
  ])('rejects unsafe raw target %s rather than falling through', (target) => {
    expect(classifyMobileRouteTarget(target)).toEqual({ kind: 'rejected' });
  });

  it('rejects separator topology changes at every decode layer', () => {
    for (const separator of ['%2f', '%2F', '%5c', '%5C', '%252f', '%252F', '%255c', '%255C']) {
      expect(classifyMobileRouteTarget(`/mobile/v2/conversations${separator}secret`)).toEqual({
        kind: 'rejected',
      });
    }
  });
});

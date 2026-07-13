import {
  buildHarnessEnvironment,
  defaultScenarioMatrix,
  parseRunnerArguments,
  selectIPhoneDestination,
} from './run-live-gateway-tests.mjs';

describe('live gateway iOS runner', () => {
  it('selects an available iPhone only from the pinned iOS 18.4 runtime', () => {
    const simctl = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-3': [
          { name: 'iPhone 16 Pro', udid: 'OLD', isAvailable: true },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-4': [
          { name: 'Unavailable iPhone', udid: 'MISSING', isAvailable: false },
          { name: 'iPad Pro 13-inch (M4)', udid: 'PAD-1', isAvailable: true },
          { name: 'iPhone 16 Pro', udid: 'PHONE-1', isAvailable: true },
        ],
      },
    };

    expect(selectIPhoneDestination(simctl)).toBe('id=PHONE-1');
    expect(selectIPhoneDestination({ devices: {} })).toBeNull();
  });

  it('parses one explicit scenario and Swift target', () => {
    expect(
      parseRunnerArguments([
        '--scenario',
        'question',
        '--only-testing',
        'DashIntegrationTests/ChatResumeIntegrationTests/testQuestionAnswer',
      ]),
    ).toEqual([
      {
        scenario: 'question',
        target: 'DashIntegrationTests/ChatResumeIntegrationTests/testQuestionAnswer',
      },
    ]);
  });

  it.each([
    ['unknown scenario', ['--scenario', 'other', '--only-testing', 'Target/test']],
    ['missing target', ['--scenario', 'stream']],
    [
      'duplicate flag',
      ['--scenario', 'stream', '--scenario', 'slow', '--only-testing', 'Target/test'],
    ],
    ['unknown flag', ['--scenario', 'stream', '--only-testing', 'Target/test', '--verbose']],
  ])('rejects %s before spawning', (_label, values) => {
    expect(() => parseRunnerArguments(values)).toThrow();
  });

  it('uses all six frozen live cases when no arguments are passed', () => {
    expect(parseRunnerArguments([])).toEqual(defaultScenarioMatrix);
    expect(defaultScenarioMatrix.map((entry) => entry.scenario)).toEqual([
      'stream',
      'stream',
      'stream',
      'question',
      'slow',
      'slow',
    ]);
  });

  it('maps readiness into exactly the seven Swift environment values', () => {
    expect(
      buildHarnessEnvironment(
        {
          managementBaseUrl: 'http://127.0.0.1:9300',
          chatWebSocketUrl: 'ws://127.0.0.1:9200/ws/chat',
          managementToken: 'management-secret',
          chatToken: 'chat-secret',
          gatewayId: 'gateway-1',
          agentId: 'agent-1',
        },
        'slow',
      ),
    ).toEqual({
      DASH_TEST_MANAGEMENT_URL: 'http://127.0.0.1:9300',
      DASH_TEST_CHAT_URL: 'ws://127.0.0.1:9200/ws/chat',
      DASH_TEST_MANAGEMENT_TOKEN: 'management-secret',
      DASH_TEST_CHAT_TOKEN: 'chat-secret',
      DASH_TEST_GATEWAY_ID: 'gateway-1',
      DASH_TEST_AGENT_ID: 'agent-1',
      DASH_TEST_SCENARIO: 'slow',
    });
  });
});

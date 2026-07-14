import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

const workflowSource = await readFile('.github/workflows/ios.yml', 'utf8');
const workflow = parse(workflowSource);
const steps = workflow?.jobs?.ios?.steps;
const uiTestFiles = [
  'PairingUITests.swift',
  'ConversationUITests.swift',
  'AgentsUITests.swift',
  'AccessibilityUITests.swift',
].map((name) => `ios/DashUITests/${name}`);
const uiTestSources = await Promise.all(uiTestFiles.map((path) => readFile(path, 'utf8')));
const uiTestCaseSource = await readFile('ios/DashUITests/DashUITestCase.swift', 'utf8');
const pairingUITestSource = await readFile('ios/DashUITests/PairingUITests.swift', 'utf8');
const composerSource = await readFile('ios/Dash/Features/Conversations/ComposerView.swift', 'utf8');
const conversationListSource = await readFile(
  'ios/Dash/Features/Conversations/ConversationListView.swift',
  'utf8',
);
const agentDetailSource = await readFile('ios/Dash/Features/Agents/AgentDetailView.swift', 'utf8');

assert.ok(Array.isArray(steps), 'expected jobs.ios.steps in the parsed workflow');

const simulatorStep = steps.find(
  (step) => step.name === 'Ensure pinned simulator runtime and devices',
);
assert.equal(typeof simulatorStep?.run, 'string', 'expected a simulator preflight command');
assert.match(simulatorStep.run, /ensure-simulators\.sh --iphone-udid/);
assert.match(simulatorStep.run, /ensure-simulators\.sh --ipad-udid/);
assert.match(simulatorStep.run, /GITHUB_ENV/);
assert.match(
  simulatorStep.run,
  /IPHONE_UDID=.*GITHUB_ENV/s,
  'simulator preflight must export the exact phone UDID for privacy reset',
);
assert.match(
  simulatorStep.run,
  /IPAD_UDID=.*GITHUB_ENV/s,
  'simulator preflight must export the exact iPad UDID for privacy reset',
);

const appIconStep = steps.find((step) => step.name === 'Verify deterministic AppIcon');
assert.match(
  appIconStep?.run ?? '',
  /git status --porcelain --untracked-files=all/,
  'AppIcon drift detection must reject generated untracked files',
);

const phoneStep = steps.find((step) => step.name === 'Unit and contract tests');
const phoneUIStep = steps.find((step) => step.name === 'iPhone UI tests');
const ipadUIStep = steps.find((step) => step.name === 'iPad adaptive UI tests');

assert.match(
  phoneUIStep?.run ?? '',
  /simctl privacy "\$IPHONE_UDID" reset camera app\.dash\.ios/,
  'iPhone UI tests must reset camera privacy on the exact pinned device',
);
assert.match(
  ipadUIStep?.run ?? '',
  /simctl privacy "\$IPAD_UDID" reset camera app\.dash\.ios/,
  'iPad UI tests must reset camera privacy on the exact pinned device',
);

for (const [name, step] of [
  ['Unit and contract tests', phoneStep],
  ['iPhone UI tests', phoneUIStep],
]) {
  assert.match(step?.run ?? '', /\$IOS_TEST_DESTINATION/, `${name} must use the exact phone UDID`);
}
assert.match(
  ipadUIStep?.run ?? '',
  /\$IOS_IPAD_TEST_DESTINATION/,
  'iPad adaptive UI tests must use the exact iPad UDID',
);
assert.match(
  ipadUIStep?.run ?? '',
  /-resultBundlePath ios\/iPadUI\.xcresult/,
  'iPad UI failures must create an artifact for upload',
);
assert.match(
  ipadUIStep?.run ?? '',
  /-scheme DashUI/,
  'iPad adaptive UI tests must run the complete DashUI scheme',
);
assert.match(
  ipadUIStep?.run ?? '',
  /-scheme DashUI \\\n\s+-destination "\$IOS_IPAD_TEST_DESTINATION"/,
  'iPad adaptive UI tests must continue the xcodebuild command onto the exact destination',
);
assert.doesNotMatch(
  ipadUIStep?.run ?? '',
  /-only-testing:/,
  'iPad adaptive UI tests must not filter out regular-width coverage',
);
assert.doesNotMatch(
  workflowSource,
  /-destination ['"]?platform=iOS Simulator,name=/,
  'fixed simulator destinations must not select by ambiguous device name',
);

for (const [index, source] of uiTestSources.entries()) {
  assert.match(
    source,
    /func test\w+\s*\(/,
    `${uiTestFiles[index]} must contain an executable UI test`,
  );
}

assert.match(pairingUITestSource, /addUIInterruptionMonitor/);
assert.match(pairingUITestSource, /Don’t Allow/);
assert.match(pairingUITestSource, /Don't Allow/);
assert.doesNotMatch(
  uiTestCaseSource,
  /mgmt-test-token|chat-test-token|relay-device-credential/,
  'token-bearing values must never travel through launch environment or arguments',
);
assert.doesNotMatch(
  pairingUITestSource,
  /#?"\{"v":|relay-device-credential/,
  'token-bearing pasteboard payload fixtures must stay inside the debug app binary',
);
assert.doesNotMatch(uiTestCaseSource, /DASH_UI_TEST_PASTEBOARD\b|--dash-ui-test-pasteboard["']/);

assert.match(composerSource, /\.keyboardShortcut\("l", modifiers: \.command\)/);
assert.match(composerSource, /\.keyboardShortcut\(\.return, modifiers: \.command\)/);
assert.match(composerSource, /\.keyboardShortcut\(\.cancelAction\)/);
for (const [source, hint] of [
  [conversationListSource, 'Connect to the gateway to rename'],
  [conversationListSource, 'Connect to the gateway to delete'],
  [composerSource, 'Connect to the gateway to send'],
  [agentDetailSource, 'Connect to the gateway to start a conversation'],
  [agentDetailSource, 'Connect to the gateway to edit'],
  [agentDetailSource, 'Connect to the gateway to manage this agent'],
]) {
  assert.match(source, new RegExp(`accessibilityHint\\([\\s\\S]*${hint}`));
}

const uiTestSource = uiTestSources.join('\n');
const uiTestCount = uiTestSource.match(/func test\w+\s*\(/g)?.length ?? 0;
assert.ok(uiTestCount >= 20, `expected at least 20 UI tests, found ${uiTestCount}`);

console.log(
  `PASS: iOS workflow runs ${uiTestCount} non-empty UI tests on exact simulator UDIDs`,
);

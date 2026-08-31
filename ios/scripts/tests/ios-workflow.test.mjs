import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

const workflowSource = await readFile('.github/workflows/ios.yml', 'utf8');
const workflow = parse(workflowSource);
const steps = workflow?.jobs?.ios?.steps;
const uiTestFiles = [
  'ConversationUITests.swift',
  'AgentsUITests.swift',
  'AccessibilityUITests.swift',
  'AccountUITests.swift',
].map((name) => `ios/DashUITests/${name}`);
const uiTestSources = await Promise.all(uiTestFiles.map((path) => readFile(path, 'utf8')));
const conversationUITestSource = uiTestSources[0];
const agentUITestSource = uiTestSources[1];
const uiTestCaseSource = await readFile('ios/DashUITests/DashUITestCase.swift', 'utf8');
const accessibilityUITestSource = await readFile(
  'ios/DashUITests/AccessibilityUITests.swift',
  'utf8',
);
const composerSource = await readFile('ios/Dash/Features/Conversations/ComposerView.swift', 'utf8');
const chatFeatureSource = await readFile(
  'ios/Dash/Features/Conversations/ChatFeature.swift',
  'utf8',
);
const conversationListSource = await readFile(
  'ios/Dash/Features/Conversations/ConversationListView.swift',
  'utf8',
);
const recoveryConfirmationModifierSource = conversationListSource.match(
  /private struct PendingSendRecoveryConfirmationModifier[\s\S]*?private struct RecoveryAttachmentPreviewView/,
)?.[0];
const deletedRecoveryUITestSource = conversationUITestSource.match(
  /func testDeletedPendingSendRecoveryIsReachablePreviewableAndExplicitlyDiscarded\(\)[\s\S]*?func testActivePendingSendRecovery/,
)?.[0];
const agentDetailSource = await readFile('ios/Dash/Features/Agents/AgentDetailView.swift', 'utf8');
const infoPlistSource = await readFile('ios/Dash/Resources/Info.plist', 'utf8');
const privacyManifestSource = await readFile(
  'ios/Dash/Resources/PrivacyInfo.xcprivacy',
  'utf8',
).catch(() => '');
const xcodeProjectSource = await readFile('ios/Dash.xcodeproj/project.pbxproj', 'utf8');
const [baseXcconfig, debugXcconfig, releaseXcconfig] = await Promise.all([
  readFile('ios/Config/Base.xcconfig', 'utf8'),
  readFile('ios/Config/Debug.xcconfig', 'utf8'),
  readFile('ios/Config/Release.xcconfig', 'utf8'),
]);
const projectSpec = parse(await readFile('ios/project.yml', 'utf8'));

assert.doesNotMatch(
  infoPlistSource,
  /NSAllowsLocalNetworking|NSAllowsArbitraryLoads/,
  'pinned HTTPS LAN transport must not depend on App Transport Security exceptions',
);

// `AccountAuthConfig.fromBundle` refuses Base.xcconfig's placeholder control-plane
// host outright, so every build configuration needs the same optional local
// override to be pointable at a real deployment — Release included, or a locally
// built archive can never sign in at all.
assert.match(baseXcconfig, /DASH_CONTROL_PLANE_URL/);
for (const [name, source] of [
  ['Debug.xcconfig', debugXcconfig],
  ['Release.xcconfig', releaseXcconfig],
]) {
  assert.match(
    source,
    /^#include\? "Local\.xcconfig"$/m,
    `${name} must optionally include the gitignored Local.xcconfig override`,
  );
}

assert.ok(Array.isArray(steps), 'expected jobs.ios.steps in the parsed workflow');

for (const target of ['DashTests', 'DashContractTests', 'DashIntegrationTests', 'DashUITests']) {
  assert.equal(
    projectSpec?.targets?.[target]?.settings?.base?.GENERATE_INFOPLIST_FILE,
    'YES',
    `${target} must generate its test-bundle Info.plist on every supported Xcode version`,
  );
}

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
const darkContrastUIStep = steps.find(
  (step) => step.name === 'Dark increased-contrast core-flow UI test',
);
const ipadUIStep = steps.find((step) => step.name === 'iPad adaptive UI tests');

assert.match(
  phoneUIStep?.run ?? '',
  /simctl boot "\$IPHONE_UDID"[\s\S]*simctl bootstatus "\$IPHONE_UDID" -b[\s\S]*simctl ui "\$IPHONE_UDID" appearance light/,
  'iPhone UI tests must boot the pinned simulator before mutating its UI state',
);
assert.match(
  phoneUIStep?.run ?? '',
  /simctl privacy "\$IPHONE_UDID" reset camera app\.dash\.ios/,
  'iPhone UI tests must reset camera privacy on the exact pinned device',
);
assert.match(
  phoneUIStep?.run ?? '',
  /simctl ui "\$IPHONE_UDID" appearance light/,
  'regular iPhone UI tests must explicitly use light appearance',
);
assert.match(
  phoneUIStep?.run ?? '',
  /simctl ui "\$IPHONE_UDID" increase_contrast disabled/,
  'regular iPhone UI tests must explicitly disable increased contrast',
);
assert.match(
  phoneUIStep?.run ?? '',
  /test "\$\(xcrun simctl ui "\$IPHONE_UDID" appearance\)" = "light"/,
  'regular iPhone UI tests must verify the selected appearance',
);
assert.match(
  phoneUIStep?.run ?? '',
  /test "\$\(xcrun simctl ui "\$IPHONE_UDID" increase_contrast\)" = "disabled"/,
  'regular iPhone UI tests must verify the selected contrast state',
);
assert.equal(
  typeof darkContrastUIStep?.run,
  'string',
  'expected an isolated dark increased-contrast UI-test step',
);
assert.match(
  darkContrastUIStep?.run ?? '',
  /simctl boot "\$IPHONE_UDID"[\s\S]*simctl bootstatus "\$IPHONE_UDID" -b[\s\S]*original_appearance="\$\(xcrun simctl ui "\$IPHONE_UDID" appearance\)"/,
  'dark appearance coverage must boot the pinned simulator before querying its UI state',
);
assert.match(
  darkContrastUIStep?.run ?? '',
  /original_appearance="\$\(xcrun simctl ui "\$IPHONE_UDID" appearance\)"/,
  'dark appearance coverage must query the simulator state before changing it',
);
assert.match(
  darkContrastUIStep?.run ?? '',
  /original_contrast="\$\(xcrun simctl ui "\$IPHONE_UDID" increase_contrast\)"/,
  'increased-contrast coverage must query the simulator state before changing it',
);
assert.match(
  darkContrastUIStep?.run ?? '',
  /trap restore_simulator_ui_state EXIT/,
  'dark increased-contrast coverage must restore simulator state on every exit',
);
assert.match(darkContrastUIStep?.run ?? '', /appearance dark/);
assert.match(darkContrastUIStep?.run ?? '', /increase_contrast enabled/);
assert.match(
  darkContrastUIStep?.run ?? '',
  /test "\$\(xcrun simctl ui "\$IPHONE_UDID" appearance\)" = "dark"/,
  'dark appearance coverage must verify the selected appearance',
);
assert.match(
  darkContrastUIStep?.run ?? '',
  /test "\$\(xcrun simctl ui "\$IPHONE_UDID" increase_contrast\)" = "enabled"/,
  'dark appearance coverage must verify the selected contrast state',
);
assert.match(
  darkContrastUIStep?.run ?? '',
  /-only-testing:DashUITests\/AccessibilityUITests\/testCoreFlowsInCurrentAppearance/,
  'dark increased-contrast coverage must isolate the appearance-safe core-flow test',
);
assert.match(
  darkContrastUIStep?.run ?? '',
  /-resultBundlePath ios\/iPhoneDarkContrastUI\.xcresult/,
  'dark increased-contrast failures must create a distinct artifact for upload',
);
assert.match(
  ipadUIStep?.run ?? '',
  /simctl boot "\$IPAD_UDID"[\s\S]*simctl bootstatus "\$IPAD_UDID" -b[\s\S]*simctl privacy "\$IPAD_UDID" reset camera app\.dash\.ios/,
  'iPad UI tests must boot the pinned simulator before resetting privacy state',
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

assert.doesNotMatch(
  uiTestCaseSource,
  /mgmt-test-token|chat-test-token|relay-device-credential/,
  'token-bearing values must never travel through launch environment or arguments',
);
assert.doesNotMatch(uiTestCaseSource, /DASH_UI_TEST_PASTEBOARD\b|--dash-ui-test-pasteboard["']/);
assert.match(
  agentUITestSource,
  /revealSidebarIfNeeded\(toExpose: "conversation\.list", in: app\)/,
  'agent creation must reveal a collapsed iPad sidebar before checking launch readiness',
);
assert.match(
  uiTestCaseSource,
  /app\.sheets\.matching\(\s*NSPredicate\(format: "label == %@", title\)\s*\)\.firstMatch/,
  'confirmation lookup must accept iOS 18 sheets that expose the title as their own label',
);
assert.ok(recoveryConfirmationModifierSource, 'expected the recovery confirmation modifier');
assert.match(
  recoveryConfirmationModifierSource,
  /\.alert\(/,
  'recovery discard must use an accessible alert presentation',
);
assert.doesNotMatch(
  recoveryConfirmationModifierSource,
  /\.confirmationDialog\(/,
  'recovery discard must not lose its safety message in an iPad confirmation popover',
);
assert.ok(deletedRecoveryUITestSource, 'expected the deleted recovery UI test');
assert.match(
  deletedRecoveryUITestSource,
  /confirmationDialog\(titled: "Discard both recovery copies\?", in: app\)/,
  'deleted recovery UI coverage must use the adaptive confirmation lookup',
);
assert.doesNotMatch(
  deletedRecoveryUITestSource,
  /app\.sheets|PopoverDismissRegion/,
  'deleted recovery UI coverage must not hard-code an iPad popover representation',
);
assert.match(
  uiTestCaseSource,
  /"-AppleLanguages",\s*"\(en\)",\s*"-AppleLocale",\s*"en_US"/,
  'UI tests must pin English so native edit-menu labels stay deterministic',
);
assert.match(
  uiTestCaseSource,
  /field\.press\(forDuration: 1\.0\)[\s\S]*label == %@[\s\S]*Select All[\s\S]*selectAll\.coordinate\(withNormalizedOffset: CGVector\(dx: 0\.5, dy: 0\.5\)\)\.tap\(\)[\s\S]*field\.typeText\(XCUIKeyboardKey\.delete\.rawValue\)[\s\S]*waitForClearedTextValue\([\s\S]*field\.typeText\(value\)/,
  'text replacement must select all through the edit menu and observe the cleared field',
);
assert.doesNotMatch(
  uiTestCaseSource,
  /field\.typeText\(String\(repeating: XCUIKeyboardKey\.delete\.rawValue, count: current\.count\)\)/,
  'text replacement must not assume that the current string length locates the caret',
);

assert.match(composerSource, /\.keyboardShortcut\("l", modifiers: \.command\)/);
assert.match(composerSource, /\.keyboardShortcut\(\.return, modifiers: \.command\)/);
assert.match(composerSource, /\.keyboardShortcut\(\.cancelAction\)/);
assert.match(
  infoPlistSource,
  /<key>UISupportedInterfaceOrientations<\/key>[\s\S]*?<string>UIInterfaceOrientationPortrait<\/string>[\s\S]*?<string>UIInterfaceOrientationLandscapeLeft<\/string>[\s\S]*?<string>UIInterfaceOrientationLandscapeRight<\/string>/,
  'iPhone must declare its supported portrait and landscape orientations',
);
assert.match(
  infoPlistSource,
  /<key>UISupportedInterfaceOrientations~ipad<\/key>[\s\S]*?<string>UIInterfaceOrientationPortrait<\/string>[\s\S]*?<string>UIInterfaceOrientationPortraitUpsideDown<\/string>[\s\S]*?<string>UIInterfaceOrientationLandscapeLeft<\/string>[\s\S]*?<string>UIInterfaceOrientationLandscapeRight<\/string>/,
  'iPad must support all orientations for multitasking',
);
assert.notEqual(
  privacyManifestSource,
  '',
  'the app target must include ios/Dash/Resources/PrivacyInfo.xcprivacy',
);
assert.match(
  privacyManifestSource,
  /<key>NSPrivacyAccessedAPITypes<\/key>\s*<array>\s*<dict>\s*<key>NSPrivacyAccessedAPIType<\/key>\s*<string>NSPrivacyAccessedAPICategoryUserDefaults<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>\s*<string>CA92\.1<\/string>\s*<\/array>\s*<\/dict>\s*<\/array>/,
  'the privacy manifest must declare app-only UserDefaults access with reason CA92.1',
);
assert.match(
  xcodeProjectSource,
  /PrivacyInfo\.xcprivacy in Resources/,
  'the generated app target must copy PrivacyInfo.xcprivacy into the bundle',
);
for (const [source, hint] of [
  [agentDetailSource, 'Connect to the gateway to start a conversation'],
  [agentDetailSource, 'Connect to the gateway to edit'],
  [agentDetailSource, 'Connect to the gateway to manage this agent'],
]) {
  assert.match(source, new RegExp(`accessibilityHint\\([\\s\\S]*${hint}`));
}
for (const [policyProperty, hint] of [
  ['renameDisabledHint', 'Connect to the gateway to rename'],
  ['deleteDisabledHint', 'Connect to the gateway to delete'],
]) {
  assert.match(
    conversationListSource,
    new RegExp(`${policyProperty}[\\s\\S]*${hint}`),
    `the conversation action policy must retain actionable ${policyProperty} guidance`,
  );
  assert.match(
    conversationListSource,
    new RegExp(`accessibilityHint\\(actions\\.${policyProperty}\\)`),
    `the conversation row must announce its ${policyProperty}`,
  );
}
assert.match(
  composerSource,
  /accessibilityHint\(feature\.composerDisabledReason \?\? ""\)/,
  'the composer must announce its actual disabled reason',
);
assert.match(
  chatFeatureSource,
  /if connection != \.online \{ return "Connect to the gateway to send" \}/,
  'the dynamic composer hint must retain actionable offline guidance',
);
assert.match(
  accessibilityUITestSource,
  /func testCoreFlowsInCurrentAppearance\(\)/,
  'appearance CI must exercise an explicit core-flow UI test',
);
assert.match(
  accessibilityUITestSource,
  /func isExposed\(\) -> Bool \{[\s\S]*value\.exists[\s\S]*value\.isHittable[\s\S]*value\.frame\.intersects\(settingsList\.frame\)[\s\S]*value\.frame\.intersects\(window\.frame\)/,
  'settings scrolling must require the target to be hittable and inside both list and window',
);
assert.match(
  accessibilityUITestSource,
  /for _ in 0\.\.<maxSwipes where isExposed\(\) == false/,
  'settings scrolling must continue until the target is exposed',
);
assert.match(
  accessibilityUITestSource,
  /XCTAssertTrue\(\s*isExposed\(\)/,
  'settings scrolling must assert that the target was exposed',
);

const uiTestSource = uiTestSources.join('\n');
const uiTestCount = uiTestSource.match(/func test\w+\s*\(/g)?.length ?? 0;
// PairingUITests.swift (4 tests) was deleted in Task 7 of the iOS account
// sign-in plan along with the QR/paste/manual pairing entry it covered, and
// AccountUITests.swift replaced it with coverage of the account sign-in entry
// path — so the pre-existing floor of 20 stands rather than being lowered.
assert.ok(uiTestCount >= 20, `expected at least 20 UI tests, found ${uiTestCount}`);

console.log(`PASS: iOS workflow runs ${uiTestCount} non-empty UI tests on exact simulator UDIDs`);

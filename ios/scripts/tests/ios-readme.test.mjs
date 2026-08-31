import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [readme, xcodeVersion] = await Promise.all([
  readFile('ios/README.md', 'utf8'),
  readFile('ios/.xcode-version', 'utf8').then((value) => value.trim()),
]);

for (const concept of [
  'conversation-sync-v1',
  'chat-resume-v1',
  'LAN',
  'relay',
  'Keychain',
  'SwiftData',
  'iOS 17',
]) {
  assert.match(readme, new RegExp(concept), `README must document ${concept}`);
}

const escapedVersion = xcodeVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
assert.match(
  readme,
  new RegExp(`Xcode ${escapedVersion} selected`),
  'README must name the exact Xcode version selected by repository scripts',
);
assert.doesNotMatch(
  readme,
  new RegExp(`Xcode ${escapedVersion} or newer`),
  'README must not claim that the exact-version simulator preflight accepts newer Xcode releases',
);
assert.match(
  readme,
  /ensure-simulators\.sh --iphone-udid/,
  'README test commands must query the exact pinned iPhone UDID',
);
assert.doesNotMatch(
  readme,
  /-destination ['"]platform=iOS Simulator,name=/,
  'README test commands must not select potentially ambiguous simulator display names',
);
assert.doesNotMatch(
  readme,
  /mgmt-test-token|chat-test-token|relay-device-credential/,
  'README must not contain fixture credentials',
);
assert.match(
  readme,
  /node ios\/scripts\/run-live-gateway-tests\.mjs/,
  'README must document the owned real-gateway runner',
);
assert.match(
  readme,
  /insert-only pending sends/,
  'README must document that pending sends cannot overwrite an existing recovery record',
);
assert.match(
  readme,
  /durable deletion revision floors/,
  'README must document the persistent monotonic deletion boundary',
);
assert.match(
  readme,
  /Same-gateway reactivation preserves that floor/,
  'README must document the lifecycle boundary for reconnecting the same gateway',
);
assert.match(
  readme,
  /Only a strictly newer canonical active summary can revive the conversation ID/,
  'README must document the strict-newer revival rule',
);
assert.match(
  readme,
  /--scenario question[\s\\]+--only-testing[\s\\]+DashIntegrationTests\/ChatResumeIntegrationTests\/testQuestionAnswer/,
  'README must include one exact focused real-gateway example',
);
assert.doesNotMatch(
  readme,
  /export DASH_TEST_|launchctl setenv DASH_TEST_/,
  'README must not ask developers to place live gateway values in shell history',
);

console.log('PASS: iOS README matches the pinned toolchain and contains no fixture credentials');

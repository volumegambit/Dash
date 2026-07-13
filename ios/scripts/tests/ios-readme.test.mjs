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

console.log('PASS: iOS README matches the pinned toolchain and contains no fixture credentials');

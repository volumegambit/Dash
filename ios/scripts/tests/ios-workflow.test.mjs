import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

const workflowSource = await readFile('.github/workflows/ios.yml', 'utf8');
const workflow = parse(workflowSource);
const steps = workflow?.jobs?.ios?.steps;

assert.ok(Array.isArray(steps), 'expected jobs.ios.steps in the parsed workflow');

const simulatorStep = steps.find(
  (step) => step.name === 'Ensure pinned simulator runtime and devices',
);
assert.equal(typeof simulatorStep?.run, 'string', 'expected a simulator preflight command');
assert.match(simulatorStep.run, /ensure-simulators\.sh --iphone-udid/);
assert.match(simulatorStep.run, /ensure-simulators\.sh --ipad-udid/);
assert.match(simulatorStep.run, /GITHUB_ENV/);

const appIconStep = steps.find((step) => step.name === 'Verify deterministic AppIcon');
assert.match(
  appIconStep?.run ?? '',
  /git status --porcelain --untracked-files=all/,
  'AppIcon drift detection must reject generated untracked files',
);

const phoneStep = steps.find((step) => step.name === 'Unit and contract tests');
const phoneUIStep = steps.find((step) => step.name === 'iPhone UI tests');
const ipadUIStep = steps.find((step) => step.name === 'iPad adaptive UI tests');

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
assert.doesNotMatch(
  workflowSource,
  /-destination ['"]?platform=iOS Simulator,name=/,
  'fixed simulator destinations must not select by ambiguous device name',
);

console.log(
  'PASS: iOS workflow uses exact simulator UDIDs, captures UI results, and rejects asset drift',
);

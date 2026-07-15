import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = join(repositoryRoot, 'package.json');
const configurationPath = join(repositoryRoot, 'ios', 'Config', 'Base.xcconfig');

const rootPackage = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: unknown };
if (
  typeof rootPackage.version !== 'string' ||
  /^\d+\.\d+\.\d+$/.test(rootPackage.version) === false
) {
  throw new Error('Root package version must be a three-part numeric semantic version');
}

const configuration = await readFile(configurationPath, 'utf8');
const marketingVersionSetting = /^MARKETING_VERSION\s*=.*$/m;
if (marketingVersionSetting.test(configuration) === false) {
  throw new Error('MARKETING_VERSION is missing from ios/Config/Base.xcconfig');
}

const updated = configuration.replace(
  marketingVersionSetting,
  `MARKETING_VERSION = ${rootPackage.version}`,
);
if (updated !== configuration) {
  await writeFile(configurationPath, updated);
}

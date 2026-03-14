import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * One-time migration: moves legacyDir to newDir if legacyDir exists and newDir does not.
 * Safe to call on every startup — is a no-op once migration has occurred.
 */
export async function migrateLegacyDataDir(legacyDir: string, newDir: string): Promise<void> {
  if (!existsSync(legacyDir)) return;
  if (existsSync(newDir)) return;

  console.log(`Migrating data directory: ${legacyDir} → ${newDir}`);
  await mkdir(dirname(newDir), { recursive: true });
  await rename(legacyDir, newDir);
}

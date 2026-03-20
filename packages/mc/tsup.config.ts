import { readFile, readdir, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { defineConfig } from 'tsup';

// esbuild strips the `node:` prefix from builtin imports for compatibility.
// This causes issues when electron-vite bundles the dist — its SSR mode
// resolves bare "path"/"fs" to __vite-browser-external. The onSuccess hook
// restores the `node:` prefix in all dist JS files after each build.
const builtinPattern = new RegExp(`from "((?:${builtinModules.join('|')})(?:/[^"]*)?)"`, 'g');

export default defineConfig({
  entry: ['src/index.ts', 'src/runtime/provider-keys.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  async onSuccess() {
    const distDir = join(import.meta.dirname, 'dist');
    const files = await readdir(distDir);
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      const filePath = join(distDir, file);
      const content = await readFile(filePath, 'utf-8');
      const fixed = content.replace(builtinPattern, (_, mod) => `from "node:${mod}"`);
      if (fixed !== content) {
        await writeFile(filePath, fixed, 'utf-8');
      }
    }
  },
});

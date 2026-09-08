import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The renderer may not VALUE-import an Electron-main barrel.
 *
 * `@dash/mc`'s root entry re-exports the gateway supervisor and the keychain
 * store, which reach for `node:os`, `node:child_process` and
 * `@napi-rs/keyring`. Vite replaces those with its browser-external stub, and
 * that stub THROWS on first property access — so one value import anywhere in
 * the renderer's eager module graph kills the whole app at startup: the window
 * renders BLANK, with `Module "os" has been externalized for browser
 * compatibility. Cannot access "os.homedir" in client code.` and no React error
 * boundary to catch it.
 *
 * It cost this branch its first live Mission Control run: `chat.tsx` and
 * `AgentConfigTab.tsx` imported `subagentsEnabledFor` from the barrel, and
 * every jsdom test still passed because vitest runs in Node, where `os.homedir`
 * exists. Nothing but launching the app could see it. Hence this test.
 *
 * Type-only imports are fine — they are erased before the bundler sees them.
 * Browser-safe pieces of the package are published as their own `exports`
 * subpaths (`@dash/mc/provider-keys`, `@dash/mc/gateway-client`); import from
 * those instead.
 */
const MAIN_ONLY_BARRELS = ['@dash/mc'];

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(HERE, 'renderer');

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...(await sourceFiles(full)));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('renderer import boundary', () => {
  it('never value-imports an Electron-main barrel', async () => {
    const files = await sourceFiles(RENDERER);
    expect(files.length).toBeGreaterThan(50); // the walk found the tree, not an empty dir

    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const barrel of MAIN_ONLY_BARRELS) {
        // Every `import … from '<barrel>'`, capturing the clause between the
        // `import` keyword and `from` so a leading `type` can be checked. The
        // clause may not contain `;` — that keeps a preceding side-effect
        // import (`import 'x';`) from being swallowed into this one's clause.
        const re = new RegExp(`import\\s+([^;]*?)\\s*from\\s+'${barrel}'`, 'g');
        for (const match of text.matchAll(re)) {
          if (!/^type\b/.test(match[1].trim())) {
            offenders.push(`${relative(HERE, file)} → import ${match[1].trim()} from '${barrel}'`);
          }
        }
      }
    }

    const why = [
      `The renderer must not value-import ${MAIN_ONLY_BARRELS.join(', ')} — the barrel drags`,
      'node builtins into the browser bundle and blanks the window at startup. Use a',
      "browser-safe subpath (e.g. '@dash/mc/gateway-client') or `import type`.",
    ].join(' ');
    expect(offenders, why).toEqual([]);
  });
});

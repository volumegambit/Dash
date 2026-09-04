import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Chat UX Phase 4 Task 2 (audit #11): iOS styling must come from
 * `DashTheme`'s semantic tokens, not ad-hoc literals. Before this sweep the
 * app had 23 sites with their own corner radii (8/10/12/16/18/20/24) and
 * opacities (.07/.08/.1/.12/.14/.18/.7/.8). This is a source-scan guard —
 * SwiftUI can't be introspected for it at runtime — so a new literal fails
 * CI with its exact location rather than silently re-fragmenting the scale.
 */
const appRoot = fileURLToPath(new URL('../Dash/', import.meta.url));
const tokenFile = 'DesignSystem/DashTheme.swift';

function swiftFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...swiftFiles(full));
    else if (entry.endsWith('.swift')) out.push(full);
  }
  return out;
}

const RADIUS_LITERAL = /cornerRadius:\s*\d/g;
const OPACITY_LITERAL = /\.opacity\(\s*0?\.\d/g;

describe('iOS design tokens (chat-ux Phase 4 Task 2, audit #11)', () => {
  it('has no ad-hoc corner-radius or opacity literals outside DashTheme', () => {
    const offenders: string[] = [];
    for (const file of swiftFiles(appRoot)) {
      const rel = relative(appRoot, file);
      if (rel === tokenFile) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (RADIUS_LITERAL.test(line) || OPACITY_LITERAL.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
        RADIUS_LITERAL.lastIndex = 0;
        OPACITY_LITERAL.lastIndex = 0;
      });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

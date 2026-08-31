// @vitest-environment node
//
// styles.css isn't imported anywhere tests can render through (only
// `main.tsx` loads it) and jsdom/happy-dom don't compute real CSS anyway —
// see the chat-ux Phase 2 Task 1 brief ("jsdom can't render; rely on
// discipline"). This is a raw-text smoke test: it pins the semantic design
// tokens (Task 1) and the dark-mode mirror of Mission Control's palette
// (docs/plans/2026-08-31-output-rendering-design.md appendix §0) so a future
// edit can't silently drop a token or the dark override block.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

/** Slices out one balanced `{ ... }` block starting at the first match of
 * `marker` that is followed (after only whitespace) by `{` — i.e. the actual
 * rule, not a prose mention of the same text inside a comment above it. */
function ruleBlock(marker: string): string {
  const re = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`);
  const match = css.match(re);
  if (!match || match.index === undefined) throw new Error(`styles.css has no rule for ${marker}`);
  const braceStart = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unterminated rule block for ${marker}`);
}

/** The dark-mode override block only — everything inside the single
 * `@media (prefers-color-scheme: dark)` rule (which itself wraps a nested
 * `:root { ... }`). */
function darkBlock(): string {
  return ruleBlock('@media (prefers-color-scheme: dark)');
}

/** The light-scheme `:root { ... }` rule (the actual rule, not the file
 * header comment's prose mentions of `` `:root` ``). */
function rootBlock(): string {
  return ruleBlock(':root');
}

describe('styles.css design tokens (chat-ux Phase 2 Task 1)', () => {
  it('declares the semantic token set on :root', () => {
    for (const token of [
      '--surface',
      '--surface-raised',
      '--border',
      '--text',
      '--text-muted',
      '--accent',
      '--radius',
    ]) {
      expect(css).toContain(`${token}:`);
    }
    expect(css).toMatch(/--radius:\s*0\s*;/);
  });

  it("mirrors Mission Control's dark palette exactly inside prefers-color-scheme: dark", () => {
    const dark = darkBlock();
    // background #0a0a0a, foreground #f8fafc, surfaces #141414, border
    // #262626, muted #94a3b8, accent #2563eb (spec appendix §0).
    expect(dark).toMatch(/--surface:\s*#0a0a0a\s*;/);
    expect(dark).toMatch(/--text:\s*#f8fafc\s*;/);
    expect(dark).toMatch(/--surface-raised:\s*#141414\s*;/);
    expect(dark).toMatch(/--border:\s*#262626\s*;/);
    expect(dark).toMatch(/--text-muted:\s*#94a3b8\s*;/);
    expect(dark).toMatch(/--accent:\s*#2563eb\s*;/);
  });

  it('keeps the light scheme as the derived (formerly-hardcoded) palette', () => {
    const root = rootBlock();
    expect(root).toMatch(/--surface:\s*#ffffff\s*;/);
    expect(root).toMatch(/--border:\s*#dddddd\s*;/);
    expect(root).toMatch(/--text-muted:\s*#888888\s*;/);
  });

  it('keeps the fenced-code chip (--md-code-bg) fixed dark in BOTH schemes', () => {
    // Appendix §0/§2: the code-block background is hardcoded #161b22 in MC,
    // not theme-aware — it must appear once, in :root, and never be
    // redeclared inside the dark override.
    expect(css).toMatch(/--md-code-bg:\s*#161b22\s*;/);
    expect(darkBlock()).not.toContain('--md-code-bg');
  });

  it('declares the 100dvh layout shell with a scrollable transcript and docked composer', () => {
    expect(css).toMatch(/\.app-shell\s*{[^}]*height:\s*100dvh/);
    expect(css).toMatch(/\.app-transcript\s*{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.app-transcript\s*{[^}]*overscroll-behavior:\s*contain/);
    expect(css).toMatch(/\.app-message-column\s*{[^}]*max-inline-size:\s*46rem/);
    expect(css).toContain('.app-composer-row');
  });

  it('clamps the composer textarea autogrow to ~40dvh (chat-ux Phase 2 Task 2, audit #3)', () => {
    expect(css).toMatch(/\.app-composer-textarea\s*{[^}]*max-height:\s*40dvh/);
    expect(css).toMatch(/\.app-composer-textarea\s*{[^}]*overflow-y:\s*auto/);
  });

  it('declares a distinct stop-button rule for the composer send↔stop morph', () => {
    expect(css).toContain('.app-composer-stop');
  });

  it('turns the sidebar into an overlay drawer under 768px', () => {
    expect(css).toContain('@media (max-width: 768px)');
    const mobile = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(mobile).toContain('.app-hamburger');
    expect(mobile).toContain('.app-sidebar--open');
  });
});

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
 * `marker` (within `source`, `css` by default) that is followed (after only
 * whitespace) by `{` — i.e. the actual rule, not a prose mention of the same
 * text inside a comment above it. Pass a narrower `source` (e.g. a slice
 * already scoped to one `@media` block) to disambiguate a selector that's
 * declared more than once at different points in the file (e.g.
 * `.app-sidebar`'s desktop grid-column rule vs. its mobile-drawer rule). */
function ruleBlock(marker: string, source: string = css): string {
  const re = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`);
  const match = source.match(re);
  if (!match || match.index === undefined) throw new Error(`styles.css has no rule for ${marker}`);
  const braceStart = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
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

/** The `@media (max-width: 768px) { ... }` mobile-drawer block — scopes
 * lookups of `.app-sidebar`/`.app-sidebar--open` to their MOBILE rules,
 * disambiguated from the separate desktop `.app-sidebar` grid-column rule
 * declared earlier in the file. */
function mobileDrawerBlock(): string {
  return ruleBlock('@media (max-width: 768px)');
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

  it('never removes the empty banner row from the `.app-main` grid flow (fix C1 layout trap: ' +
    '`display: none` on `.app-banner-row:empty` reassigns the implicit `auto 1fr auto` grid ' +
    'rows the moment there is no banner content — which is the DEFAULT state on every normal ' +
    'page load — so `.app-transcript-wrap` (whose only child, `.app-transcript`, is ' +
    '`position: absolute` and contributes no auto height) collapses to zero and ' +
    '`.app-composer-row` balloons to fill the leftover `1fr` instead)', () => {
    const emptyRule = ruleBlock('.app-banner-row:empty');
    expect(emptyRule).not.toMatch(/display:\s*none/);
    // The row must still visually collapse when empty — just without
    // leaving the grid's implicit row order, so `min-height: 0` (not
    // `display: none`) is the mechanism.
    expect(emptyRule).toMatch(/min-height:\s*0/);
  });

  it('turns the sidebar into an overlay drawer under 768px', () => {
    expect(css).toContain('@media (max-width: 768px)');
    const mobile = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(mobile).toContain('.app-hamburger');
    expect(mobile).toContain('.app-sidebar--open');
  });
});

describe('final-review fix wave', () => {
  it('fix I2: the CLOSED mobile drawer is visibility:hidden (not just translated off-screen), ' +
    'so it drops out of the accessibility tree/tab order rather than merely off the visible ' +
    'viewport, and the open state restores visibility:visible', () => {
    const mobile = mobileDrawerBlock();
    const closedRule = ruleBlock('.app-sidebar', mobile);
    expect(closedRule).toMatch(/visibility:\s*hidden/);
    const openRule = ruleBlock('.app-sidebar--open', mobile);
    expect(openRule).toMatch(/visibility:\s*visible/);
  });

  it('fix m1: the drawer transform/visibility transition — and the copy/message-action opacity ' +
    'reveal transitions — only apply under prefers-reduced-motion: no-preference, so a ' +
    'reduced-motion user gets the open/closed and shown/hidden end states instantly rather ' +
    'than via a suppressed-but-still-applied animation', () => {
    // Base rules must NOT themselves declare `transition` — it must live
    // only inside the `no-preference` gate.
    expect(ruleBlock('.app-sidebar', mobileDrawerBlock())).not.toMatch(/transition:/);
    expect(ruleBlock('.copy-button')).not.toMatch(/transition:/);
    expect(ruleBlock('.chat-message-action')).not.toMatch(/transition:/);

    expect(css).toContain('@media (max-width: 768px) and (prefers-reduced-motion: no-preference)');
    const drawerMotion = css.slice(
      css.indexOf('@media (max-width: 768px) and (prefers-reduced-motion: no-preference)'),
    );
    expect(drawerMotion).toMatch(/\.app-sidebar\s*{[^}]*transition:\s*transform/);

    // The reveal-fade transitions for both buttons must each be
    // immediately preceded by their own `no-preference` gate (adjacent in
    // the file, not just present somewhere) — a direct substring check,
    // since `ruleBlock` only ever returns the FIRST match of a marker and
    // there are two separate `no-preference` blocks in this file.
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) {\s*\.copy-button\s*{\s*transition:/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) {\s*\.chat-message-action\s*{\s*transition:/,
    );
  });

  it('fix I3: --text-muted-strong meets WCAG AA (>=4.5:1) against --surface in both schemes, and ' +
    '.chat-message-action uses it at full opacity for its rest state (not the ~1.75:1 ' +
    'color-mix(...50%, transparent) it used to render at), going to --text on hover/focus', () => {
    expect(rootBlock()).toMatch(/--text-muted-strong:\s*#595f6b\s*;/);
    expect(darkBlock()).toMatch(/--text-muted-strong:\s*#a8b3c4\s*;/);

    const actionRule = ruleBlock('.chat-message-action');
    expect(actionRule).toMatch(/color:\s*var\(--text-muted-strong\)/);
    // Not the OLD low-contrast declaration (the ~1.75:1 color-mix this
    // fix replaces) — check the actual `color:` VALUE, not the whole
    // block (which legitimately mentions `color-mix` in the explanatory
    // comment above the property).
    expect(actionRule).not.toMatch(/color:\s*color-mix/);

    expect(css).toMatch(/\.chat-message-action:hover\s*{[^}]*color:\s*var\(--text\)/);
  });
});

describe('chat-ux Phase 3 Task 4 (audit #18, #13 remainder): motion + empty states', () => {
  it('gates the message entrance fade-rise keyframe animation under prefers-reduced-motion: ' +
    'no-preference — the only place `.chat-message`/`.chat-message-streaming` declare an ' +
    '`animation` at all is inside that media query', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) {\s*\.chat-message,\s*\.chat-message-streaming\s*{\s*animation:\s*message-enter/,
    );
    // `message-enter` is referenced by exactly one declaration (the gated
    // one above) — never duplicated ungated elsewhere in the file.
    expect(css.split('animation: message-enter').length - 1).toBe(1);

    const keyframe = ruleBlock('@keyframes message-enter');
    expect(keyframe).toMatch(/opacity:\s*0/);
    expect(keyframe).toMatch(/transform:\s*translateY/);
  });

  it('keeps the message-enter keyframe presentation-only — no border-radius (hard corners stay ' +
    'at --radius: 0)', () => {
    expect(ruleBlock('@keyframes message-enter')).not.toMatch(/border-radius/);
  });

  it('gates the conversation-list skeleton pulse under prefers-reduced-motion: no-preference, ' +
    "and uses --border (not --surface-raised, the sidebar's own background) so it is visible", () => {
    expect(ruleBlock('.conversation-skeleton-line')).not.toMatch(/animation:/);
    expect(ruleBlock('.conversation-skeleton-line')).toMatch(/background:\s*var\(--border\)/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) {\s*\.conversation-skeleton-line\s*{\s*animation:\s*skeleton-pulse/,
    );
  });

  it('styles the empty-chat greeting and starter prompts with semantic tokens, hard corners, and ' +
    'a reduced-motion-gated hover transition', () => {
    const prompt = ruleBlock('.chat-empty-state-prompt');
    expect(prompt).toMatch(/color:\s*var\(--text-muted-strong\)/);
    expect(prompt).not.toMatch(/border-radius/);
    expect(prompt).not.toMatch(/transition:/);
    // Final-review fix m5: `--accent` is byte-identical light/dark (only
    // `--accent-hover` differs), and #2563eb text on the dark scheme's
    // #0a0a0a surface fails WCAG AA (~3.83:1, under the 4.5:1 minimum) —
    // `--accent-hover` clears 4.5:1 in both schemes (see styles.css's
    // comment on this rule for the computed ratios).
    expect(css).toMatch(
      /\.chat-empty-state-prompt:hover,\s*\.chat-empty-state-prompt:focus-visible\s*{[^}]*color:\s*var\(--accent-hover\)/,
    );
    expect(css).not.toMatch(
      /\.chat-empty-state-prompt:hover,\s*\.chat-empty-state-prompt:focus-visible\s*{[^}]*color:\s*var\(--accent\);/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) {\s*\.chat-empty-state-prompt\s*{\s*transition:/,
    );
  });
});

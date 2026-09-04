import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Scroll-pinning + jump-to-bottom (chat-ux Phase 2 Task 3, audit #4): web's
 * side of the same concept `ChatView.swift`'s `isNearBottom` implements on
 * iOS — "is the user currently following the bottom of the transcript, or
 * did they scroll up to read something older" — plus the auto-scroll and
 * re-pin behaviors that key off it.
 *
 * A `containerRef`/`sentinelRef` pair (attach `containerRef` to the
 * scrollable transcript — `.app-transcript`, `data-testid="chat-transcript"`
 * — and `sentinelRef` to a zero-height marker rendered immediately after the
 * last message) drives an `IntersectionObserver`, scoped to the container
 * via `root`, that flips `pinned` to `false` the moment the user scrolls the
 * sentinel out of view and back to `true` once it's visible again (covers
 * both "scrolled up" and "manually scrolled back down to the bottom" without
 * a separate scroll listener).
 *
 * jsdom/happy-dom have no *functional* `IntersectionObserver` (construction
 * succeeds but the callback never fires from real layout — see the task 3
 * brief), so `createObserver` is an injectable factory: production code
 * relies on the default (the real global), and
 * `usePinnedScroll.test.ts` passes a fake that records the callback and lets
 * the test drive `entries` manually. This is the intended test seam — keep
 * `ChatView`'s usage of this hook thin so behavior stays covered here rather
 * than only reachable through a real browser.
 *
 * POST-MORTEM (final-review fix C2): `containerRef`/`sentinelRef` used to be
 * plain `useRef`s, and the observer-mounting effect below depended only on
 * `[createObserver]` (stable in production). That's correct IF the
 * container/sentinel DOM nodes already exist the first time this hook's
 * component mounts. `ChatView` calls this hook unconditionally, ABOVE its
 * `if (!conversationId) return <empty state>` branch — so when it first
 * mounts with `conversationId === null` (no conversation picked yet), the
 * transcript markup these refs attach to is never rendered, the refs stay
 * `null` forever, the effect's one-shot run below is a no-op, and because
 * `ChatView` is never unmounted/remounted just for picking a conversation
 * (see its own draft-per-conversation comment), the effect never gets a
 * second chance to run — pinning/auto-scroll/jump-to-bottom were silently
 * inert for every session's first conversation. Fixed by switching to
 * CALLBACK refs backed by state (`containerEl`/`sentinelEl` below): the
 * callback fires — and updates state, triggering a re-render — the moment
 * React actually attaches the DOM node, whenever that happens, so the
 * observer-mounting effect (now keyed on that state) reliably fires exactly
 * once the nodes genuinely exist, regardless of whether that's on first
 * mount or a later render.
 */
export interface UsePinnedScrollOptions {
  /** Changes when the open conversation itself changes (e.g. the
   * conversation id). On change, the hook re-pins and snaps (not smoothly —
   * this is a context switch, not new content arriving) to the bottom,
   * mirroring `ChatView.swift`'s `.onAppear { scrollToBottom(animated:
   * false) }`. */
  resetKey: unknown;
  /** Changes whenever new content might need to be auto-scrolled into view
   * (a new message, a streamed token/tool-card delta). Mirrors iOS's
   * `ChatTranscriptSignature` (audit #4): cheap to compute from just the
   * last message so callers can pass a fresh value on every render without
   * worrying about cost. Auto-scroll only fires while `pinned`. */
  contentSignature: unknown;
  /** Test seam — see the file header. Defaults to constructing the real
   * global `IntersectionObserver`. */
  createObserver?: (
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) => IntersectionObserver;
  /** Test seam (Phase 4 review I1) — defaults to the real global
   * `ResizeObserver` when one exists, otherwise a no-op. */
  createResizeObserver?: (callback: ResizeObserverCallback) => ResizeObserver;
  /** Test seam for the reduced-motion check below (`window.matchMedia`
   * itself is present in happy-dom, but doesn't evaluate real OS/browser
   * preference — tests that care about the smooth-vs-auto choice inject
   * this instead of relying on the environment). */
  prefersReducedMotion?: () => boolean;
}

export interface UsePinnedScrollResult {
  /** Attach to the scrollable transcript container (the `IntersectionObserver`'s `root`).
   * A CALLBACK ref, not a plain `RefObject` (post-mortem below) — pass it
   * straight to the element's `ref` prop, same as a plain ref. */
  containerRef: (node: HTMLDivElement | null) => void;
  /** Attach to a zero-height sentinel rendered immediately after the last message.
   * Also a callback ref — see `containerRef`. */
  sentinelRef: (node: HTMLDivElement | null) => void;
  /** `true` while the bottom sentinel is visible in the container — i.e. the
   * user is following the live transcript. Drives the jump-to-bottom pill's
   * visibility (rendered when `!pinned`). */
  pinned: boolean;
  /** Re-pins and scrolls to the bottom. Wire to the jump-to-bottom pill's
   * `onClick`. */
  jumpToBottom: () => void;
}

function defaultPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function defaultCreateResizeObserver(callback: ResizeObserverCallback): ResizeObserver {
  if (typeof ResizeObserver === 'undefined') {
    return { observe() {}, unobserve() {}, disconnect() {} } as unknown as ResizeObserver;
  }
  return new ResizeObserver(callback);
}

function defaultCreateObserver(
  callback: IntersectionObserverCallback,
  options?: IntersectionObserverInit,
): IntersectionObserver {
  return new IntersectionObserver(callback, options);
}

export function usePinnedScroll({
  resetKey,
  contentSignature,
  createObserver = defaultCreateObserver,
  createResizeObserver = defaultCreateResizeObserver,
  prefersReducedMotion = defaultPrefersReducedMotion,
}: UsePinnedScrollOptions): UsePinnedScrollResult {
  // Backed by state (not `useRef`) so attachment itself is observable — see
  // the CALLBACK REF post-mortem above. `useCallback` with an empty
  // dependency array keeps each setter's identity stable across renders, so
  // it isn't re-invoked by React on every render the way an inline arrow
  // function passed straight to `ref` would be.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [sentinelEl, setSentinelEl] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => setContainerEl(node), []);
  const sentinelRef = useCallback((node: HTMLDivElement | null) => setSentinelEl(node), []);
  const [pinned, setPinned] = useState(true);
  // Read inside the content-driven effect below without adding `pinned` to
  // its dependency array — that effect must only react to NEW CONTENT
  // arriving, not to `pinned` itself flipping (which would otherwise fire an
  // extra, unwanted auto-scroll the instant the user re-pins).
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      if (!containerEl) return;
      containerEl.scrollTo({ top: containerEl.scrollHeight, behavior });
    },
    [containerEl],
  );

  // Mount/observe the bottom sentinel once per container+sentinel pair.
  // Depends on `containerEl`/`sentinelEl` (state, not refs) precisely so
  // this re-runs the moment React actually attaches those DOM nodes — see
  // the CALLBACK REF post-mortem above. `createObserver` stays a dependency
  // too (stable in production, test-provided in `usePinnedScroll.test.ts`).
  useEffect(() => {
    if (!sentinelEl || !containerEl) return;
    const observer = createObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setPinned(entry.isIntersecting);
      },
      { root: containerEl, threshold: 0 },
    );
    observer.observe(sentinelEl);
    return () => observer.disconnect();
  }, [createObserver, containerEl, sentinelEl]);

  // Content resize while pinned → re-snap (Phase 4 review I1). With
  // `content-visibility: auto` on rows, a freshly-opened transcript lays
  // rows below the first viewport out at their placeholder height, so the
  // reset snap below lands short and the real heights arrive a frame later;
  // attachment thumbnails decoding late do the same. Watching the content
  // element (the message column — the container's first child) and
  // re-snapping instantly while the user is still following the bottom
  // keeps every one of those honest. Never fires once unpinned.
  useEffect(() => {
    if (!containerEl) return;
    const target = containerEl.firstElementChild ?? containerEl;
    const observer = createResizeObserver(() => {
      if (pinnedRef.current) scrollToBottom('auto');
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [createResizeObserver, containerEl, scrollToBottom]);

  // Conversation switch (or first mount): re-pin and snap to the bottom —
  // this is a context change, not streamed content, so it's never smooth.
  // `containerEl` is included alongside `resetKey` on purpose (not just via
  // `scrollToBottom`'s closure): if `resetKey` changes on the very render
  // the transcript DOM first mounts, `containerEl` is still `null` on THAT
  // render (the callback ref attaches during commit, one render later), so
  // the initial snap-to-bottom would otherwise silently no-op — re-running
  // this effect once `containerEl` itself becomes available closes that gap.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey/containerEl are the intentional triggers; scrollToBottom is derived from containerEl already
  useEffect(() => {
    setPinned(true);
    scrollToBottom('auto');
  }, [resetKey, containerEl]);

  // New content (a message arriving, a streamed delta): auto-scroll ONLY
  // while pinned (audit #4) — this is the behavior the old code never had at
  // all ("Web: no scroll logic at all").
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentSignature is the intentional trigger; pinnedRef/scrollToBottom/prefersReducedMotion are read fresh via ref or are stable
  useEffect(() => {
    if (!pinnedRef.current) return;
    scrollToBottom(prefersReducedMotion() ? 'auto' : 'smooth');
  }, [contentSignature]);

  const jumpToBottom = useCallback(() => {
    setPinned(true);
    scrollToBottom(prefersReducedMotion() ? 'auto' : 'smooth');
  }, [scrollToBottom, prefersReducedMotion]);

  return { containerRef, sentinelRef, pinned, jumpToBottom };
}

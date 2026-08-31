import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

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
  /** Test seam for the reduced-motion check below (`window.matchMedia`
   * itself is present in happy-dom, but doesn't evaluate real OS/browser
   * preference — tests that care about the smooth-vs-auto choice inject
   * this instead of relying on the environment). */
  prefersReducedMotion?: () => boolean;
}

export interface UsePinnedScrollResult {
  /** Attach to the scrollable transcript container (the `IntersectionObserver`'s `root`). */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Attach to a zero-height sentinel rendered immediately after the last message. */
  sentinelRef: RefObject<HTMLDivElement | null>;
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
  prefersReducedMotion = defaultPrefersReducedMotion,
}: UsePinnedScrollOptions): UsePinnedScrollResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  // Read inside the content-driven effect below without adding `pinned` to
  // its dependency array — that effect must only react to NEW CONTENT
  // arriving, not to `pinned` itself flipping (which would otherwise fire an
  // extra, unwanted auto-scroll the instant the user re-pins).
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior });
  }, []);

  // Mount/observe the bottom sentinel once per container+sentinel pair.
  // `createObserver` is the only real dependency (stable in production,
  // test-provided in `usePinnedScroll.test.ts`) — the refs themselves are
  // mutable containers, not reactive values, and don't belong in the
  // dependency array.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = containerRef.current;
    if (!sentinel || !container) return;
    const observer = createObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setPinned(entry.isIntersecting);
      },
      { root: container, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [createObserver]);

  // Conversation switch (or first mount): re-pin and snap to the bottom —
  // this is a context change, not streamed content, so it's never smooth.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the intentional trigger (a conversation switch); scrollToBottom is stable
  useEffect(() => {
    setPinned(true);
    scrollToBottom('auto');
  }, [resetKey]);

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

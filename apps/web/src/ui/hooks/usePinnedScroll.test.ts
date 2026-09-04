import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { usePinnedScroll } from './usePinnedScroll.js';
import type { UsePinnedScrollOptions } from './usePinnedScroll.js';

/**
 * jsdom/happy-dom's `IntersectionObserver` constructs without error but its
 * callback never fires from real layout (see the hook's file header) — so
 * this fake is the actual test seam the hook was designed around: it
 * records the callback `usePinnedScroll` registers and lets each test drive
 * `entries` manually, exactly as the task 3 brief calls for ("capture the
 * callback, drive entries manually").
 */
function fakeObserverFactory() {
  let capturedCallback: IntersectionObserverCallback | null = null;
  const observedElements: Element[] = [];
  let disconnected = false;

  const factory = (callback: IntersectionObserverCallback) => {
    capturedCallback = callback;
    return {
      observe: (el: Element) => observedElements.push(el),
      unobserve: () => {},
      disconnect: () => {
        disconnected = true;
      },
      takeRecords: () => [],
      root: null,
      rootMargin: '',
      thresholds: [],
    } as unknown as IntersectionObserver;
  };

  return {
    factory,
    observedElements,
    isDisconnected: () => disconnected,
    /** Simulates the sentinel entering/leaving the container's viewport.
     * Wrapped in `act` because — like a real `IntersectionObserver` — this
     * fires the captured callback outside of React's own event handling. */
    fireIntersection(isIntersecting: boolean) {
      if (!capturedCallback) throw new Error('observer callback was never captured');
      const callback = capturedCallback;
      act(() => {
        callback(
          [{ isIntersecting }] as unknown as IntersectionObserverEntry[],
          {} as unknown as IntersectionObserver,
        );
      });
    },
  };
}

/** Renders the hook through a real component (rather than manually poking
 * refs via `renderHook`), so `containerRef`/`sentinelRef` attach to real DOM
 * nodes exactly the way `ChatView` will use them — the same convention the
 * rest of this repo's component tests already follow (real `render`, not
 * mocked refs). */
function Harness(props: UsePinnedScrollOptions) {
  const { containerRef, sentinelRef, pinned, jumpToBottom } = usePinnedScroll(props);
  return createElement(
    'div',
    null,
    createElement(
      'div',
      { 'data-testid': 'container', ref: containerRef },
      createElement('div', { 'data-testid': 'content' }, 'content'),
      createElement('div', { 'data-testid': 'sentinel', ref: sentinelRef }),
    ),
    createElement('output', { 'data-testid': 'pinned-state' }, pinned ? 'pinned' : 'unpinned'),
    createElement('button', { type: 'button', onClick: jumpToBottom }, 'Jump'),
  );
}

/** Same seam for `ResizeObserver` (Phase 4 review I1): happy-dom has no
 * functional one, so the hook takes a factory and the test fires it. */
function fakeResizeObserverFactory() {
  let capturedCallback: ResizeObserverCallback | null = null;
  const observedElements: Element[] = [];
  const factory = (callback: ResizeObserverCallback) => {
    capturedCallback = callback;
    return {
      observe: (el: Element) => observedElements.push(el),
      unobserve: () => {},
      disconnect: () => {},
    } as unknown as ResizeObserver;
  };
  return {
    factory,
    observedElements,
    fireResize() {
      if (!capturedCallback) throw new Error('resize callback was never captured');
      const callback = capturedCallback;
      act(() => {
        callback([] as unknown as ResizeObserverEntry[], {} as unknown as ResizeObserver);
      });
    },
  };
}

function renderHarness(overrides: Partial<UsePinnedScrollOptions> = {}) {
  const fake = fakeObserverFactory();
  const resize = fakeResizeObserverFactory();
  const prefersReducedMotion = vi.fn(() => false);
  const utils = render(
    createElement(Harness, {
      resetKey: 'conv-1',
      contentSignature: 0,
      createObserver: fake.factory,
      createResizeObserver: resize.factory,
      prefersReducedMotion,
      ...overrides,
    }),
  );
  const container = screen.getByTestId('container') as HTMLDivElement;
  const scrollToSpy = vi.spyOn(container, 'scrollTo');
  return { ...utils, fake, resize, container, scrollToSpy, prefersReducedMotion };
}

describe('usePinnedScroll', () => {
  it('starts pinned and observes the sentinel, scoped to the transcript container as root', () => {
    const { fake } = renderHarness();
    expect(screen.getByTestId('pinned-state').textContent).toBe('pinned');
    expect(fake.observedElements).toEqual([screen.getByTestId('sentinel')]);
  });

  it('unpins when the bottom sentinel scrolls out of view (the user scrolled up)', () => {
    const { fake } = renderHarness();
    fake.fireIntersection(false);
    expect(screen.getByTestId('pinned-state').textContent).toBe('unpinned');
  });

  it('re-pins when the sentinel scrolls back into view (the user manually scrolled to the bottom)', () => {
    const { fake } = renderHarness();
    fake.fireIntersection(false);
    expect(screen.getByTestId('pinned-state').textContent).toBe('unpinned');
    fake.fireIntersection(true);
    expect(screen.getByTestId('pinned-state').textContent).toBe('pinned');
  });

  it('disconnects the observer on unmount', () => {
    const { fake, unmount } = renderHarness();
    expect(fake.isDisconnected()).toBe(false);
    unmount();
    expect(fake.isDisconnected()).toBe(true);
  });

  it('auto-scrolls to the bottom when contentSignature changes while pinned', () => {
    const { fake, scrollToSpy, rerender, container } = renderHarness({ contentSignature: 0 });
    scrollToSpy.mockClear();

    rerender(
      createElement(Harness, {
        resetKey: 'conv-1',
        contentSignature: 1,
        createObserver: fake.factory,
        prefersReducedMotion: () => false,
      }),
    );

    expect(scrollToSpy).toHaveBeenCalledWith({ top: container.scrollHeight, behavior: 'smooth' });
  });

  it('does NOT auto-scroll on new content once unpinned — this is the whole point of the pin (audit #4)', () => {
    const { fake, scrollToSpy, rerender, container } = renderHarness({ contentSignature: 0 });
    fake.fireIntersection(false);
    scrollToSpy.mockClear();

    rerender(
      createElement(Harness, {
        resetKey: 'conv-1',
        contentSignature: 1,
        createObserver: fake.factory,
        prefersReducedMotion: () => false,
      }),
    );

    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(container).toBeTruthy();
  });

  it('uses an instant ("auto") scroll, not smooth, when prefers-reduced-motion is set', () => {
    const { fake, scrollToSpy, rerender, container } = renderHarness({
      contentSignature: 0,
      prefersReducedMotion: () => true,
    });
    scrollToSpy.mockClear();

    rerender(
      createElement(Harness, {
        resetKey: 'conv-1',
        contentSignature: 1,
        createObserver: fake.factory,
        prefersReducedMotion: () => true,
      }),
    );

    expect(scrollToSpy).toHaveBeenCalledWith({ top: container.scrollHeight, behavior: 'auto' });
  });

  it('jumpToBottom re-pins (even after the user scrolled up) and scrolls to the bottom', () => {
    const { fake, scrollToSpy, container } = renderHarness();
    fake.fireIntersection(false);
    expect(screen.getByTestId('pinned-state').textContent).toBe('unpinned');
    scrollToSpy.mockClear();

    fireEvent.click(screen.getByText('Jump'));

    expect(screen.getByTestId('pinned-state').textContent).toBe('pinned');
    expect(scrollToSpy).toHaveBeenCalledWith({ top: container.scrollHeight, behavior: 'smooth' });
  });

  it('re-pins and snaps (instant, not smooth) to the bottom when resetKey changes (a conversation switch)', () => {
    const { fake, scrollToSpy, rerender, container, prefersReducedMotion } = renderHarness();
    fake.fireIntersection(false);
    expect(screen.getByTestId('pinned-state').textContent).toBe('unpinned');
    scrollToSpy.mockClear();

    rerender(
      createElement(Harness, {
        resetKey: 'conv-2',
        contentSignature: 0,
        createObserver: fake.factory,
        prefersReducedMotion,
      }),
    );

    expect(screen.getByTestId('pinned-state').textContent).toBe('pinned');
    // Snaps regardless of reduced-motion — a conversation switch is a
    // context change, not streamed content, so it's always 'auto'.
    expect(scrollToSpy).toHaveBeenCalledWith({ top: container.scrollHeight, behavior: 'auto' });
  });

  // Phase 4 review I1: with `content-visibility: auto` on rows (Task 1),
  // rows below the first viewport are laid out at their placeholder height
  // when the conversation opens, so the reset-time `scrollTo(scrollHeight)`
  // lands short; a frame later the real heights arrive and the transcript
  // sits ~one viewport above the bottom with `pinned` false. The same
  // happens when attachment thumbnails finish decoding. Verified in Chrome
  // by the reviewer. Cure: re-snap whenever the content resizes while the
  // user is still following the bottom.
  it('observes the transcript content for size changes and re-snaps (instant) while pinned (review I1)', () => {
    const { resize, scrollToSpy, container } = renderHarness();
    expect(resize.observedElements).toContain(screen.getByTestId('content'));
    scrollToSpy.mockClear();

    resize.fireResize();

    expect(scrollToSpy).toHaveBeenCalledWith({ top: container.scrollHeight, behavior: 'auto' });
  });

  it('does not re-snap on a content resize once the user has scrolled up', () => {
    const { fake, resize, scrollToSpy } = renderHarness();
    fake.fireIntersection(false);
    scrollToSpy.mockClear();

    resize.fireResize();

    expect(scrollToSpy).not.toHaveBeenCalled();
  });
});

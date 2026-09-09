import { act, renderHook } from '@testing-library/react';
import { useElapsed } from './useElapsed.js';

const STARTED = '2026-09-04T10:00:00.000Z';

describe('useElapsed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T10:00:05.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks while the child is still running', () => {
    const { result } = renderHook(() => useElapsed(STARTED));
    expect(result.current).toBe(5_000);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current).toBe(7_000);
  });

  it('freezes on endedAt and never ticks past it', () => {
    const { result } = renderHook(() => useElapsed(STARTED, '2026-09-04T10:01:12.000Z'));
    expect(result.current).toBe(72_000);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(72_000);
  });

  it('freezes as soon as endedAt arrives, without a further tick', () => {
    const { result, rerender } = renderHook(
      ({ endedAt }: { endedAt?: string }) => useElapsed(STARTED, endedAt),
      { initialProps: {} as { endedAt?: string } },
    );
    expect(result.current).toBe(5_000);

    rerender({ endedAt: '2026-09-04T10:00:30.000Z' });
    expect(result.current).toBe(30_000);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(30_000);
  });

  // Task D2 fix item 3: a terminal child with no `endedAt` has NO known
  // duration. Returning `Date.now() - start` would report the row's own age —
  // reopen the conversation three hours later and a `cancelled` child claims
  // `3h 0m`. Ruling 5's rule ("no usable timestamp shows nothing") is exactly
  // this case.
  it('reports no elapsed at all for a terminal row that never reported an endedAt', () => {
    expect(renderHook(() => useElapsed(STARTED, undefined, false)).result.current).toBeNull();
  });

  it('reports no elapsed for a terminal row mounted long after it started', () => {
    vi.setSystemTime(new Date('2026-09-04T13:00:00.000Z'));
    expect(renderHook(() => useElapsed(STARTED, undefined, false)).result.current).toBeNull();
  });

  // A terminal child does not always have an `endedAt`: only
  // `subagent_finished` carries one, so an end-of-stream-terminalized
  // (`cancelled`) child and a legacy-only `worker_done` one both arrive
  // finished with none. `running: false` is what stops the clock for those —
  // otherwise they count up forever behind a finished glyph, one live
  // interval per row.
  it('drops the elapsed reading when a live row goes terminal without an endedAt', () => {
    const { result, rerender } = renderHook(
      ({ running }: { running: boolean }) => useElapsed(STARTED, undefined, running),
      { initialProps: { running: true } },
    );
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current).toBe(8_000);

    rerender({ running: false });
    expect(result.current).toBeNull();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBeNull();
  });

  // Ruling 5: a legacy-only child (`worker_*` carries no timestamp) has
  // `startedAt: ''` — the row must show no elapsed at all, never NaN or a
  // 1970-epoch duration.
  it('returns null for a missing or unparseable startedAt', () => {
    expect(renderHook(() => useElapsed('')).result.current).toBeNull();
    expect(renderHook(() => useElapsed(undefined)).result.current).toBeNull();
    expect(renderHook(() => useElapsed('not-a-date')).result.current).toBeNull();
  });

  it('clamps a clock that went backwards to zero rather than reporting a negative', () => {
    const { result } = renderHook(() => useElapsed('2026-09-04T10:00:09.000Z'));
    expect(result.current).toBe(0);
  });
});

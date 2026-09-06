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

  // A terminal child does not always have an `endedAt`: only
  // `subagent_finished` carries one, so an end-of-stream-terminalized
  // (`cancelled`) child and a legacy-only `worker_done` one both arrive
  // finished with none. `running: false` is what stops the clock for those —
  // otherwise they count up forever behind a finished glyph, one live
  // interval per row.
  it('stops counting once the row is terminal, even with no endedAt', () => {
    const { result } = renderHook(() => useElapsed(STARTED, undefined, false));
    expect(result.current).toBe(5_000);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(5_000);
  });

  it('stops the tick when a live row goes terminal without an endedAt', () => {
    const { result, rerender } = renderHook(
      ({ running }: { running: boolean }) => useElapsed(STARTED, undefined, running),
      { initialProps: { running: true } },
    );
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current).toBe(8_000);

    rerender({ running: false });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(8_000);
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

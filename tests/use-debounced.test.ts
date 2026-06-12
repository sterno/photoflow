// @vitest-environment jsdom

/**
 * Tests for the `useDebounced` React hook. The hook lags its input by a
 * configurable delay, suppressing intermediate values that arrive within
 * the wait window. These tests drive the hook with `renderHook` and step
 * time with Vitest's fake timers so we can assert the debounce semantics
 * without real waits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDebounced } from '@/lib/use-debounced';

describe('useDebounced', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the initial value synchronously on first render', () => {
    const { result } = renderHook(() => useDebounced('hello', 200));
    expect(result.current).toBe('hello');
  });

  it('updates to the new value after the delay elapses', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebounced(value, 300),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('b');
  });

  it('only emits the final value when updates burst within the wait window', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebounced(value, 250),
      { initialProps: { value: 'first' } },
    );

    rerender({ value: 'second' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ value: 'third' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ value: 'fourth' });

    // Still the initial — none of the intermediate timers fired.
    expect(result.current).toBe('first');

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current).toBe('fourth');
  });

  it('honors different delay values', () => {
    const { result, rerender } = renderHook(
      ({ value, ms }: { value: string; ms: number }) => useDebounced(value, ms),
      { initialProps: { value: 'x', ms: 50 } },
    );

    rerender({ value: 'y', ms: 50 });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toBe('y');

    rerender({ value: 'z', ms: 1000 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe('y');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe('z');
  });

  it('defaults to a 400ms delay when none is provided', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebounced(value),
      { initialProps: { value: 'one' } },
    );

    rerender({ value: 'two' });
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(result.current).toBe('one');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('two');
  });

  it('does not throw or warn when unmounted before the timer fires', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { rerender, unmount } = renderHook(
      ({ value }: { value: string }) => useDebounced(value, 500),
      { initialProps: { value: 'initial' } },
    );
    rerender({ value: 'pending' });

    expect(() => {
      unmount();
      vi.advanceTimersByTime(1000);
    }).not.toThrow();

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    warn.mockRestore();
    error.mockRestore();
  });

  it('restarts the wait window when the delay changes mid-flight', () => {
    const { result, rerender } = renderHook(
      ({ value, ms }: { value: string; ms: number }) => useDebounced(value, ms),
      { initialProps: { value: 'a', ms: 200 } },
    );

    rerender({ value: 'b', ms: 200 });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current).toBe('a');

    // Changing the delay should clear the old timer and start a new one.
    rerender({ value: 'b', ms: 500 });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // Old timer would have fired by now (150 + 150 = 300 > 200), but the
    // delay change reset the wait window.
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(result.current).toBe('b');
  });

  it('returns a stable reference across re-renders with the same input', () => {
    const obj = { id: 1 };
    const { result, rerender } = renderHook(
      ({ value }: { value: { id: number } }) => useDebounced(value, 100),
      { initialProps: { value: obj } },
    );

    const first = result.current;
    rerender({ value: obj });
    rerender({ value: obj });
    expect(result.current).toBe(first);
    expect(result.current).toBe(obj);
  });
});

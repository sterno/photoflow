'use client';

/**
 * Generic debounce hook used across PhotoFlow's filter and search UIs to
 * avoid firing a query (or expensive client-side filter) on every keystroke.
 */
import { useEffect, useState } from 'react';

/**
 * Returns a value that lags behind its input by `ms` milliseconds with no
 * updates during the wait window. Useful for filter inputs that should only
 * trigger work once the user stops typing.
 */
export function useDebounced<T>(value: T, ms: number = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    // Each new value resets the timer; the cleanup cancels the previous
    // scheduled update so only the final value within the window wins.
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

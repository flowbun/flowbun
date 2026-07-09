import { useState } from "react";

/**
 * A drop-in `useState` replacement mirrored to localStorage under `key` —
 * read once as the lazy initial value, written back on every update. Used
 * for small UI preferences that should survive a reload (log panel
 * collapsed/expanded, its filters, which tab is active) without needing a
 * server round-trip, unlike everything else this app persists (which lives
 * in the wiring files themselves).
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored !== null ? (JSON.parse(stored) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  function set(value: T | ((prev: T) => T)): void {
    setState((prev) => {
      const next =
        typeof value === "function" ? (value as (p: T) => T)(prev) : value;
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // localStorage unavailable/full (private browsing, quota) — state
        // still updates in-memory for this session, it just won't persist.
      }
      return next;
    });
  }

  return [state, set];
}

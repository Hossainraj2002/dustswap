"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** True after the first client render. Use to gate anything time- or storage-dependent. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

function noopSubscribe() {
  return () => {};
}

export function useMediaQuery(query: string, serverFallback = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : serverFallback),
    () => serverFallback,
  );
}

/** Regular width (iPad landscape / desktop) in HIG size-class terms. */
export function useIsRegularWidth(): boolean {
  return useMediaQuery("(min-width: 1024px)");
}

export function useReducedMotionPreference(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/**
 * A shared clock. Every subscriber re-renders on the same tick, so ages and
 * countdowns across the page stay in step without one interval per row.
 */
const clockListeners = new Set<() => void>();
let clockNow = 0;
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      clockListeners.forEach((notify) => notify());
    }, 1000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function getClockSnapshot() {
  // The snapshot must be stable between calls until the clock ticks.
  if (clockNow === 0) clockNow = Date.now();
  return clockNow;
}

/** Current time in ms, updated once per second. 0 during server render. */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, getClockSnapshot, () => 0);
}

/** requestAnimationFrame-driven time for smooth rings; stops when `active` is false. */
export function useAnimationNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const loop = () => {
      setNow(Date.now());
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return now;
}

/** Remembers the previous value of a prop. */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  const previous = ref.current;
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return previous;
}

/** localStorage-backed state that tolerates blocked storage. */
export function useLocalStorageState<T>(key: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      // Storage blocked or corrupt; keep the initial value.
    }
  }, [key]);
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private mode; the in-memory value still works for this session.
      }
    },
    [key],
  );
  return [value, update];
}

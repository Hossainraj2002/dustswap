'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type AppShellMode = 'normal' | 'baseapp-top';

const BASEAPP_QUERY_VALUE = 'baseapp';
const BASEAPP_TOP_MODE: AppShellMode = 'baseapp-top';
const MOBILE_BREAKPOINT_PX = 768;
const OFFSET_BUCKET_SIZE_PX = 8;
const OFFSET_CHANGE_THRESHOLD = 2;
const OFFSET_NOISE_THRESHOLD_PX = 4;
const OFFSET_RANGE_THRESHOLD_PX = 24;
const SESSION_STORAGE_KEY = 'ds-shell-mode';
const STARTUP_DETECTION_WINDOW_MS = 900;
const UNSTABLE_DISTINCT_VALUE_THRESHOLD = 3;

const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

function getSavedShellMode(): AppShellMode | null {
  try {
    return window.sessionStorage.getItem(SESSION_STORAGE_KEY) === BASEAPP_TOP_MODE
      ? BASEAPP_TOP_MODE
      : null;
  } catch {
    return null;
  }
}

function persistShellMode(mode: AppShellMode) {
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, mode);
  } catch {
    // Ignore storage failures so navigation never breaks.
  }
}

function isLikelyEmbeddedLaunch() {
  if (typeof window === 'undefined') return false;

  try {
    if (window.self !== window.top) {
      return true;
    }
  } catch {
    return true;
  }

  if (!document.referrer) {
    return false;
  }

  try {
    return new URL(document.referrer).hostname === 'base.app';
  } catch {
    return false;
  }
}

function readViewportBottomOffset() {
  const visualViewport = window.visualViewport;
  const layoutViewportHeight = Math.max(
    window.innerHeight,
    document.documentElement.clientHeight
  );
  const visibleViewportHeight = visualViewport?.height ?? layoutViewportHeight;
  const visibleViewportTop = visualViewport?.offsetTop ?? 0;

  return Math.round(
    Math.max(
      0,
      layoutViewportHeight - (visibleViewportTop + visibleViewportHeight)
    )
  );
}

function normalizeBottomOffset(offset: number) {
  if (offset <= OFFSET_NOISE_THRESHOLD_PX) {
    return 0;
  }

  return Math.round(offset / OFFSET_BUCKET_SIZE_PX) * OFFSET_BUCKET_SIZE_PX;
}

function isUnstableOffsetHistory(
  distinctOffsets: Set<number>,
  offsetChanges: number
) {
  if (distinctOffsets.size >= UNSTABLE_DISTINCT_VALUE_THRESHOLD) {
    return true;
  }

  if (distinctOffsets.size === 0) {
    return false;
  }

  const offsets = Array.from(distinctOffsets);
  const offsetRange = Math.max(...offsets) - Math.min(...offsets);

  return (
    offsetRange >= OFFSET_RANGE_THRESHOLD_PX &&
    offsetChanges >= OFFSET_CHANGE_THRESHOLD
  );
}

interface UseAppShellModeOptions {
  enableStartupDetection: boolean;
  pathname: string;
}

function getShellParamFromLocation() {
  if (typeof window === 'undefined') {
    return null;
  }

  return new URLSearchParams(window.location.search).get('shell')?.toLowerCase() ?? null;
}

export function useAppShellMode({
  enableStartupDetection,
  pathname,
}: UseAppShellModeOptions): AppShellMode {
  const [mode, setMode] = useState<AppShellMode>('normal');
  const didAttemptStartupDetectionRef = useRef(false);

  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const shellParam = getShellParamFromLocation();

    if (shellParam === BASEAPP_QUERY_VALUE) {
      persistShellMode(BASEAPP_TOP_MODE);
      setMode(BASEAPP_TOP_MODE);
      return;
    }

    const savedMode = getSavedShellMode();
    if (savedMode) {
      setMode(savedMode);
      return;
    }

    setMode('normal');

    if (!enableStartupDetection || didAttemptStartupDetectionRef.current) {
      return;
    }

    didAttemptStartupDetectionRef.current = true;

    if (
      window.innerWidth >= MOBILE_BREAKPOINT_PX ||
      !window.visualViewport ||
      !isLikelyEmbeddedLaunch()
    ) {
      return;
    }

    const startedAt = window.performance.now();
    const distinctOffsets = new Set<number>();
    let frameId: number | null = null;
    let lastOffset: number | null = null;
    let offsetChanges = 0;

    const sample = () => {
      const normalizedOffset = normalizeBottomOffset(readViewportBottomOffset());

      distinctOffsets.add(normalizedOffset);

      if (lastOffset !== null && normalizedOffset !== lastOffset) {
        offsetChanges += 1;
      }
      lastOffset = normalizedOffset;

      if (isUnstableOffsetHistory(distinctOffsets, offsetChanges)) {
        persistShellMode(BASEAPP_TOP_MODE);
        setMode(BASEAPP_TOP_MODE);
        return;
      }

      if (
        window.performance.now() - startedAt >= STARTUP_DETECTION_WINDOW_MS
      ) {
        return;
      }

      frameId = window.requestAnimationFrame(sample);
    };

    frameId = window.requestAnimationFrame(sample);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [enableStartupDetection, pathname]);

  return mode;
}

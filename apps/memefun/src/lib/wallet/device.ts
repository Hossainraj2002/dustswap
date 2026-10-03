// Lightweight runtime device detection (client-only). Guard for SSR: callers
// should read this inside an effect/state to avoid hydration mismatches.
export function isMobileDevice() {
  if (typeof navigator === "undefined") {
    return false;
  }
  const userAgent = navigator.userAgent || "";
  const isIpadOS =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const hasCoarsePointer =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) ||
    isIpadOS ||
    hasCoarsePointer
  );
}

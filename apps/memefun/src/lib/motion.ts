import type { Transition } from "motion/react";

/** Spring presets tuned to feel like UIKit's default and interactive springs. */
export const spring = {
  /** Default for most UI movement (segments, tabs, list inserts). */
  snappy: { type: "spring", stiffness: 520, damping: 40, mass: 0.9 } satisfies Transition,
  /** Sheets and larger surfaces. */
  sheet: { type: "spring", stiffness: 380, damping: 38, mass: 1 } satisfies Transition,
  /** Soft settle for celebratory moments. */
  gentle: { type: "spring", stiffness: 220, damping: 26, mass: 1 } satisfies Transition,
} as const;

export const fade: Transition = { duration: 0.2, ease: [0.32, 0.72, 0, 1] };

"use client";

import { type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/cn";
import { useLocalStorageState, useReducedMotionPreference } from "@/lib/hooks";
import { IconButton } from "./IconButton";

/**
 * Continuous ticker. The content is rendered twice and shifted by half its
 * width, so the loop is seamless. It pauses on hover and keyboard focus, has
 * a remembered pause button (WCAG 2.2.2), and becomes a plain scrollable row
 * when the user prefers reduced motion.
 */
export function Marquee({ children, label, className, durationSec = 60 }: { children: ReactNode; label: string; className?: string; durationSec?: number }) {
  const reduced = useReducedMotionPreference();
  const [paused, setPaused] = useLocalStorageState(`memefun:marquee-paused:${label}`, false);
  if (reduced) {
    return (
      <div role="region" aria-label={label} className={cn("mf-scroll-x flex gap-2", className)}>
        {children}
      </div>
    );
  }
  const subject = label.toLowerCase();
  return (
    <div role="region" aria-label={label} className={cn("group flex items-center gap-2", className)}>
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "flex w-max animate-marquee gap-2 group-hover:[animation-play-state:paused] group-focus-within:[animation-play-state:paused]",
            paused && "[animation-play-state:paused]",
          )}
          style={{ ["--mf-marquee-duration" as string]: `${durationSec}s` }}
        >
          <div className="flex shrink-0 gap-2">{children}</div>
          <div className="flex shrink-0 gap-2" aria-hidden inert>
            {children}
          </div>
        </div>
        <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-bg-grouped to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-bg-grouped to-transparent" />
      </div>
      <IconButton
        size="sm"
        label={paused ? `Play ${subject}` : `Pause ${subject}`}
        icon={paused ? <Play aria-hidden /> : <Pause aria-hidden />}
        onClick={() => setPaused(!paused)}
      />
    </div>
  );
}

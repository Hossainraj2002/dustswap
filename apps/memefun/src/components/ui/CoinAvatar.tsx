"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

export type AvatarRing =
  | { kind: "milestone"; progress: number }
  | { kind: "protection"; remaining: number }
  | null;

interface CoinAvatarProps {
  src?: string;
  /** Coin name. Empty string when the name is printed right next to the avatar. */
  alt: string;
  size: number;
  ring?: AvatarRing;
  className?: string;
  /** Fallback letters when there is no image or it fails to load. */
  symbol?: string;
}

/**
 * The memefun signature: an Activity-style ring around every coin.
 * Blue fills toward the next market-cap milestone ("close the ring"); during
 * the first seconds after launch it becomes an orange launch-protection
 * countdown that unwinds to zero. The ring is decorative; screens that show it
 * also state the progress in text.
 */
export function CoinAvatar({ src, alt, size, ring = null, className, symbol }: CoinAvatarProps) {
  const [failed, setFailed] = useState(false);
  const stroke = Math.max(2, Math.round(size * 0.058));
  const gap = ring ? Math.max(2, Math.round(size * 0.045)) : 0;
  const inset = ring ? stroke + gap : 0;
  const inner = size - inset * 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  let progress = 0;
  let colorClass = "stroke-tint";
  if (ring?.kind === "milestone") progress = Math.min(1, Math.max(0, ring.progress));
  if (ring?.kind === "protection") {
    progress = Math.min(1, Math.max(0, ring.remaining));
    colorClass = "stroke-warning-ring";
  }

  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      {ring ? (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90" aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-fill-2" />
          {progress > 0 ? (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - progress)}
              className={cn(colorClass, ring.kind === "milestone" && "transition-[stroke-dashoffset] duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]")}
            />
          ) : null}
        </svg>
      ) : null}
      <span
        className="absolute overflow-hidden rounded-full bg-fill-3"
        style={{ left: inset, top: inset, width: inner, height: inner }}
      >
        {src && !failed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt}
            width={inner}
            height={inner}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
            className="size-full object-cover"
          />
        ) : (
          <span
            className="flex size-full items-center justify-center font-rounded font-bold text-label-2"
            style={{ fontSize: Math.max(10, inner * 0.36) }}
            role={alt ? "img" : undefined}
            aria-label={alt || undefined}
          >
            {(symbol ?? alt).slice(0, 2).toUpperCase()}
          </span>
        )}
      </span>
    </span>
  );
}

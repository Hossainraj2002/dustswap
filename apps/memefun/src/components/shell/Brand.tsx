import { cn } from "@/lib/cn";

/** The memefun mark: a milestone ring about to close. */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={cn("shrink-0", className)} aria-hidden>
      <circle cx="16" cy="16" r="11.5" fill="none" stroke="currentColor" strokeOpacity="0.16" strokeWidth="5" />
      <path d="M16 4.5 A11.5 11.5 0 1 1 6.04 10.25" fill="none" stroke="var(--mf-tint-fill)" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <BrandMark />
      <span className="font-rounded text-title3 font-extrabold tracking-tight text-label">memefun</span>
    </span>
  );
}

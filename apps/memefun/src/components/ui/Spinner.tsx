import { cn } from "@/lib/cn";

/** iOS-style activity indicator: 8 fading spokes. */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("size-5 shrink-0 animate-spin [animation-duration:0.9s] [animation-timing-function:steps(8)]", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {Array.from({ length: 8 }, (_, index) => (
        <rect
          key={index}
          x="11"
          y="2"
          width="2"
          height="6"
          rx="1"
          fill="currentColor"
          opacity={0.25 + (index / 8) * 0.75}
          transform={`rotate(${index * 45} 12 12)`}
        />
      ))}
    </svg>
  );
}

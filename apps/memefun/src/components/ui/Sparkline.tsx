import { useId } from "react";
import { cn } from "@/lib/cn";

interface SparklineProps {
  values: number[];
  /** Drawing width in px; with `fluid` it only sets the aspect of the viewBox. */
  width?: number;
  height?: number;
  className?: string;
  /** Fill the area under the line with a soft gradient. */
  area?: boolean;
  /** Stretch to the container's width without forcing a minimum width. */
  fluid?: boolean;
}

/** Decorative trend line. Direction color comes from first vs last value. */
export function Sparkline({ values, width = 72, height = 28, className, area = false, fluid = false }: SparklineProps) {
  const gradientId = useId();
  if (values.length < 2) {
    return <svg width={fluid ? "100%" : width} height={height} className={className} aria-hidden />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const pad = 2;
  const points = values.map((value, index) => {
    const x = index * stepX;
    const y = pad + (1 - (value - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const up = (values[values.length - 1] as number) >= (values[0] as number);
  const color = up ? "var(--mf-up)" : "var(--mf-down)";

  return (
    <svg
      width={fluid ? "100%" : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={fluid ? "none" : undefined}
      className={cn("block overflow-visible", fluid && "min-w-0", className)}
      aria-hidden
    >
      {area ? (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.22" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${line} L${width} ${height} L0 ${height} Z`} fill={`url(#${gradientId})`} />
        </>
      ) : null}
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

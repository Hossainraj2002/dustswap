"use client";

import { useId } from "react";
import { CalendarDays, Clock3 } from "lucide-react";
import { BrandMark } from "@/components/shell/Brand";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/hooks";

const UNITS = ["Days", "Hours", "Minutes", "Seconds"] as const;

/** Display the scheduled launch without implying that a token has already been created. */
export function PlatformLaunchCountdown({ launchAt, className }: { launchAt: string; className?: string }) {
  const titleId = useId();
  const now = useNow();
  const launchTime = /(?:Z|[+-]\d{2}:\d{2})$/i.test(launchAt) ? Date.parse(launchAt) : NaN;
  if (!Number.isFinite(launchTime)) return null;

  // useNow returns zero on the server and during hydration, keeping the placeholder stable.
  const remaining = now === 0 ? null : Math.max(0, Math.ceil((launchTime - now) / 1000));
  const launchOpen = remaining === 0;
  const values = remaining === null ? null : [
    Math.floor(remaining / 86_400),
    Math.floor(remaining / 3_600) % 24,
    Math.floor(remaining / 60) % 60,
    remaining % 60,
  ];
  const date = new Date(launchTime);
  const launchDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
  const launchClock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(date);

  return (
    <section aria-labelledby={titleId} className={cn("mf-card relative flex min-w-0 flex-col gap-6 overflow-hidden border border-tint/20 p-5 sm:p-6", className)}>
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 size-72 rounded-full bg-tint/10 blur-3xl" />
      <div className="relative flex items-center gap-4">
        <span className="flex size-20 shrink-0 items-center justify-center rounded-xl bg-tint/8 ring-1 ring-tint/15">
          <BrandMark size={64} className="rounded-lg" />
        </span>
        <div className="min-w-0">
          <p className="mb-1 text-caption1 font-semibold uppercase tracking-wider text-tint">Platform token</p>
          <h2 id={titleId} className="text-title1 text-label">MemeFun token launch</h2>
        </div>
      </div>

      <div className="relative flex flex-col gap-3">
        <p className="flex items-center gap-2 text-subhead font-semibold text-label" role="status" aria-live="polite">
          <Clock3 className="size-4 shrink-0 text-tint" aria-hidden />
          {launchOpen ? "Launch window is open" : "Countdown to launch"}
        </p>
        <dl role="timer" aria-label="Time until the MemeFun token launch" aria-live="off" className="grid grid-cols-4 gap-2 sm:gap-3">
          {UNITS.map((unit, index) => (
            <div key={unit} className="flex min-w-0 flex-col items-center rounded-md bg-fill-4 px-1 py-4 ring-1 ring-separator/30 sm:py-5">
              <dt className="order-2 mt-1.5 text-caption1 text-label-2">{unit}</dt>
              <dd className="mf-num order-1 text-3xl font-bold leading-none tracking-tight text-label sm:text-4xl">
                {values ? String(values[index]).padStart(2, "0") : "--"}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="relative flex flex-col gap-2 border-t border-separator/40 pt-4">
        <p className="flex items-start gap-2 text-footnote font-semibold text-label">
          <CalendarDays className="mt-0.5 size-4 shrink-0 text-tint" aria-hidden />
          <time dateTime={date.toISOString()}>{launchDate} · {launchClock} UTC</time>
        </p>
        <p className="text-footnote text-label-2">Official token details will appear here after creation.</p>
      </div>
    </section>
  );
}

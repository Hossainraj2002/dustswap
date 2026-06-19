function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function CheckMiniIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function ScanPhaseStepper({ stage }: { stage: number }) {
  const phases = ["Balances", "Pricing", "Routes"];
  return (
    <div className="flex items-center gap-1.5">
      {phases.map((label, index) => {
        const done = index < stage;
        const active = index === stage;
        return (
          <div key={label} className="flex flex-1 items-center gap-1.5">
            <span
              className={cx(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition-colors",
                done
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-300"
                  : active
                    ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-400/25 dark:bg-blue-400/10 dark:text-blue-300"
                    : "border-slate-200 bg-slate-50 text-slate-400 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-500",
              )}
            >
              {done ? (
                <CheckMiniIcon className="h-2.5 w-2.5" />
              ) : active ? (
                <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
              )}
              {label}
            </span>
            {index < phases.length - 1 ? (
              <span className={cx("h-px flex-1", done ? "bg-emerald-200 dark:bg-emerald-400/20" : "bg-slate-200 dark:bg-white/10")} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center justify-between gap-3 px-2.5 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="sweep-skel h-9 w-9 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <span className="sweep-skel block h-3 w-1/3 rounded" />
          <span className="sweep-skel mt-2 block h-2.5 w-1/2 rounded" />
        </div>
      </div>
      <div className="text-right">
        <span className="sweep-skel ml-auto block h-3 w-12 rounded" />
        <span className="sweep-skel ml-auto mt-2 block h-2.5 w-8 rounded" />
      </div>
    </div>
  );
}

export default function ScanDemoPage() {
  const progress = 68;
  const stage = 1;
  return (
    <div className="min-h-screen bg-[var(--ds-bg-page)] px-4 py-8">
      <div className="mx-auto max-w-[460px] space-y-3">
        {/* Scanning card */}
        <div className="rounded-[16px] border border-blue-100 bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-blue-400/20 dark:bg-white/[0.04]">
          <div className="flex items-center gap-3">
            <span className="sweep-radar flex h-10 w-10 shrink-0 items-center justify-center">
              <span className="relative z-[1] h-1.5 w-1.5 rounded-full bg-[#0052ff] dark:bg-blue-300" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-sm font-bold text-slate-900 dark:text-white">Scanning your wallet</p>
                <span className="shrink-0 text-xs font-bold tabular-nums text-[#0052ff] dark:text-blue-300">{progress}%</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">Checking prices and sweep routes...</p>
            </div>
          </div>
          <div className="mt-3">
            <ScanPhaseStepper stage={stage} />
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100 dark:bg-white/10">
            <div
              className="sweep-bar-shimmer h-full rounded-full bg-gradient-to-r from-blue-600 to-[#0052ff] transition-[width] duration-200 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Large wallets take a few seconds — your funds aren&apos;t touched while we scan.
          </p>
        </div>

        {/* Completion flourish */}
        <div className="flex items-center justify-between gap-3 rounded-[16px] border border-emerald-200 bg-emerald-50 px-4 py-3 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-emerald-400/20 dark:bg-emerald-400/10">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-emerald-500 text-white">
              <CheckMiniIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-emerald-800 dark:text-emerald-200">Scan complete</p>
              <p className="truncate text-xs text-emerald-700 dark:text-emerald-300">453 balances scanned · 53 sweepable</p>
            </div>
          </div>
          <span className="shrink-0 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">2.4s</span>
        </div>

        {/* Skeleton rows */}
        <div className="rounded-[16px] border border-slate-200/70 bg-white p-2 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-white/10 dark:bg-white/[0.04]">
          {Array.from({ length: 5 }).map((_, index) => (
            <SkeletonRow key={index} />
          ))}
        </div>
      </div>
    </div>
  );
}

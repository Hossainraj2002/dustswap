import Link from "next/link";
import { InteractiveLeaderboardBackground } from "@/components/leaderboard/InteractiveLeaderboardBackground";

const PREVIEW_ROWS = [
  { rank: "01", name: "Wallet Alpha", score: "128,450", delta: "+12.4%" },
  { rank: "02", name: "Base Runner", score: "121,380", delta: "+8.1%" },
  { rank: "03", name: "Dust Hunter", score: "119,920", delta: "+6.7%" },
  { rank: "04", name: "Sweep Signal", score: "112,040", delta: "+4.2%" },
];

const SIDE_METRICS = [
  { label: "Mode", value: "Light Shell" },
  { label: "Route", value: "/leaderboard" },
  { label: "Status", value: "Ready for data" },
];

export default function LeaderboardPage() {
  return (
    <main className="min-h-screen bg-[#f3f7fb] px-4 py-4 md:px-8 md:py-8">
      <section className="relative mx-auto flex min-h-[calc(100vh-2rem)] max-w-7xl flex-col overflow-hidden rounded-[32px] border border-white/80 bg-white/55 shadow-[0_30px_90px_rgba(148,163,184,0.20)] backdrop-blur-xl">
        <InteractiveLeaderboardBackground />

        <div className="relative z-10 flex min-h-[calc(100vh-2rem)] flex-col gap-10 px-5 py-6 sm:px-8 sm:py-8 lg:px-12 lg:py-10">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500 shadow-[0_10px_30px_rgba(148,163,184,0.10)]">
                Route refreshed
              </div>
              <h1 className="mt-5 max-w-2xl text-4xl font-semibold tracking-[-0.06em] text-slate-950 sm:text-5xl lg:text-6xl">
                Leaderboard shell, renamed and reset for the next build.
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-600 sm:text-base">
                The old burn flow has been cleared out. This route is now a light-only premium
                canvas with the new navigation label, a clean leaderboard staging layout, and an
                interactive blue signal background that follows touch and pointer movement.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <Link
                  href="/profile"
                  className="inline-flex items-center justify-center rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition-transform duration-200 hover:-translate-y-0.5"
                >
                  View profile
                </Link>
                <Link
                  href="/quests"
                  className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white/90 px-5 py-3 text-sm font-semibold text-slate-700 shadow-[0_10px_30px_rgba(148,163,184,0.08)] transition-colors duration-200 hover:border-slate-300 hover:text-slate-950"
                >
                  Open quests
                </Link>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 lg:w-[420px]">
              {SIDE_METRICS.map((metric) => (
                <div
                  key={metric.label}
                  className="rounded-[24px] border border-white/90 bg-white/78 px-4 py-4 shadow-[0_14px_40px_rgba(148,163,184,0.12)] backdrop-blur-md"
                >
                  <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                    {metric.label}
                  </p>
                  <p className="mt-2 text-base font-semibold tracking-[-0.03em] text-slate-900">
                    {metric.value}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
            <div className="rounded-[30px] border border-white/90 bg-white/72 p-4 shadow-[0_18px_60px_rgba(148,163,184,0.14)] backdrop-blur-xl sm:p-6">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200/80 pb-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                    Leaderboard Preview
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">
                    Staging layout
                  </h2>
                </div>
                <div className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700">
                  Coming next
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {PREVIEW_ROWS.map((row) => (
                  <div
                    key={row.rank}
                    className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-3 rounded-[22px] border border-slate-200/80 bg-white/88 px-4 py-4 shadow-[0_12px_30px_rgba(148,163,184,0.08)]"
                  >
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-950 text-sm font-semibold text-white">
                      {row.rank}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">{row.name}</p>
                      <p className="mt-1 text-xs text-slate-500">Preview row ready for live ranking data</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-slate-900">{row.score}</p>
                      <p className="mt-1 text-xs font-medium text-sky-600">{row.delta}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-4">
              <div className="rounded-[30px] border border-white/90 bg-white/74 p-6 shadow-[0_18px_60px_rgba(148,163,184,0.14)] backdrop-blur-xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                  Interaction
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">
                  Background behavior
                </h2>
                <p className="mt-3 text-sm leading-7 text-slate-600">
                  The graph-paper plane tilts softly in 3D, the blue lines glow with moving signal
                  heads, and touch points create luminous ripples so taps feel alive even before
                  leaderboard data lands here.
                </p>
              </div>

              <div className="rounded-[30px] border border-white/90 bg-white/74 p-6 shadow-[0_18px_60px_rgba(148,163,184,0.14)] backdrop-blur-xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                  Ready state
                </p>
                <div className="mt-4 space-y-3">
                  <div className="rounded-[20px] border border-slate-200/80 bg-[#f8fbff] px-4 py-3">
                    <p className="text-sm font-semibold text-slate-900">Navigation updated</p>
                    <p className="mt-1 text-xs text-slate-500">Burn is now Leaderboard in the app shell.</p>
                  </div>
                  <div className="rounded-[20px] border border-slate-200/80 bg-[#f8fbff] px-4 py-3">
                    <p className="text-sm font-semibold text-slate-900">Old burn UI removed</p>
                    <p className="mt-1 text-xs text-slate-500">The previous token burn form no longer ships on this route.</p>
                  </div>
                  <div className="rounded-[20px] border border-slate-200/80 bg-[#f8fbff] px-4 py-3">
                    <p className="text-sm font-semibold text-slate-900">Light theme only</p>
                    <p className="mt-1 text-xs text-slate-500">White, blue, and grey now drive the whole experience here.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

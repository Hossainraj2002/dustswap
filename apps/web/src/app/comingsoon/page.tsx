import Link from "next/link";
import { DustSweepIcon, QuestsIcon, SwapIcon } from "@/components/NavIcons";

const statusCards = [
  {
    title: "Still under build",
    description:
      "Dust Sweep needs a bit more polish before launch so the first version feels clear and reliable.",
  },
];

export default function ComingSoonPage() {
  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-8 sm:px-6 lg:px-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.18),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(14,165,233,0.16),transparent_30%)]"
      />

      <div className="mx-auto flex min-h-[calc(100vh-6rem)] max-w-5xl items-center justify-center">
        <section className="relative w-full overflow-hidden rounded-[32px] border border-white/70 bg-white/80 p-8 shadow-[0_28px_80px_rgba(148,163,184,0.22)] backdrop-blur-xl sm:p-12">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.8),rgba(239,246,255,0.55),rgba(224,242,254,0.7))]"
          />

          <div className="relative grid gap-10 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
            <div className="space-y-6">
              <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-4 py-1.5 text-sm font-semibold uppercase tracking-[0.18em] text-sky-700">
                Coming Soon
              </span>

              <div className="space-y-5">
                <span className="flex h-16 w-16 items-center justify-center rounded-[22px] border border-sky-200 bg-white text-sky-600 shadow-[0_16px_30px_rgba(59,130,246,0.16)]">
                  <DustSweepIcon className="h-8 w-8" aria-hidden="true" />
                </span>

                <div className="space-y-4">
                  <h1
                    className="text-4xl font-bold tracking-[-0.06em] text-slate-950 sm:text-5xl"
                    style={{ fontFamily: "Syne, sans-serif" }}
                  >
                    Dust Sweep is still under build.
                  </h1>

                  <p
                    className="max-w-2xl text-lg leading-8 text-slate-600"
                    style={{ fontFamily: "DM Sans, sans-serif" }}
                  >
                    This feature is coming soon. We are keeping the live launch focused,
                    and Dust Sweep will come back once the experience is ready.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <Link
                  href="/swap"
                  className="inline-flex items-center gap-2 rounded-2xl bg-sky-600 px-5 py-3 text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-sky-500"
                >
                  <SwapIcon className="h-4 w-4" aria-hidden="true" />
                  Open Swap
                </Link>

                <Link
                  href="/quests"
                  className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition-colors duration-200 hover:bg-slate-50"
                >
                  <QuestsIcon className="h-4 w-4" aria-hidden="true" />
                  Explore Quests
                </Link>
              </div>
            </div>

            <div className="rounded-[28px] border border-slate-200/80 bg-white/85 p-6 shadow-[0_16px_36px_rgba(148,163,184,0.16)]">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">
                Status Update
              </p>

              <div className="mt-5 space-y-4">
                {statusCards.map((card) => (
                  <article
                    key={card.title}
                    className="rounded-2xl border border-slate-100 bg-slate-50/80 p-4"
                  >
                    <h2 className="text-base font-semibold text-slate-900">{card.title}</h2>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{card.description}</p>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "DustSwap Maintenance",
  description: "DustSwap is temporarily under maintenance while we restore app stability.",
};

export default function MaintenancePage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-2xl rounded-[28px] border border-slate-200 bg-white px-6 py-10 shadow-[0_24px_80px_rgba(15,23,42,0.08)] sm:px-10 sm:py-14">
        <div className="mb-6 inline-flex rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">
          Scheduled Maintenance
        </div>

        <div className="space-y-4">
          <h1 className="text-balance text-3xl font-semibold tracking-[-0.03em] text-slate-950 sm:text-4xl">
            DustSwap is under maintenance
          </h1>
          <p className="max-w-xl text-base leading-7 text-slate-600 sm:text-lg">
            We are restoring app stability. Please check back soon.
          </p>
        </div>

        <div className="mt-10 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm leading-6 text-slate-600 sm:px-5">
          Core services are being stabilized, and normal app access will return automatically once maintenance mode is disabled.
        </div>
      </div>
    </main>
  );
}

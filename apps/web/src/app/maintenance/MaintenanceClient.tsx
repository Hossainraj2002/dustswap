"use client";

import { useEffect, useMemo, useState } from "react";
import {
  MAINTENANCE_BYPASS_SESSION_KEY,
} from "@/lib/maintenanceBypassToken";

const DEFAULT_MESSAGE =
  "We are upgrading our system. We expect to be back in approximately four hours. Thank you for your patience.";

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0:00:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function MaintenanceClient() {
  const endAtMs = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_MAINTENANCE_END_AT?.trim();
    if (!raw) return null;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }, []);

  const message =
    process.env.NEXT_PUBLIC_MAINTENANCE_MESSAGE?.trim() || DEFAULT_MESSAGE;

  const [now, setNow] = useState(() => Date.now());
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (endAtMs === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [endAtMs]);

  const remainingMs = endAtMs !== null ? endAtMs - now : null;
  const showCountdown = endAtMs !== null && remainingMs !== null && remainingMs > 0;
  const countdownDone = endAtMs !== null && remainingMs !== null && remainingMs <= 0;

  async function onUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/maintenance/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        apiToken?: string;
      };
      if (!res.ok || !data.ok || typeof data.apiToken !== "string") {
        setError("Could not unlock. Check your password or try again later.");
        return;
      }
      try {
        sessionStorage.setItem(MAINTENANCE_BYPASS_SESSION_KEY, data.apiToken);
      } catch {
        setError("Storage blocked; allow site data and retry.");
        return;
      }
      window.location.href = "/";
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="theme-page flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-2xl rounded-[28px] border border-slate-200 bg-white px-6 py-10 shadow-[0_24px_80px_rgba(15,23,42,0.08)] sm:px-10 sm:py-14">
        <div className="mb-6 inline-flex rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">
          Scheduled maintenance
        </div>

        <div className="space-y-4">
          <h1 className="text-balance text-3xl font-semibold tracking-[-0.03em] text-slate-950 sm:text-4xl">
            We&apos;re upgrading DustSwap
          </h1>
          <p className="max-w-xl text-base leading-7 text-slate-600 sm:text-lg">
            {message}
          </p>
        </div>

        {showCountdown ? (
          <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 text-center sm:px-5">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
              Estimated time remaining
            </p>
            <p className="mt-2 font-mono text-3xl font-semibold tabular-nums text-slate-900">
              {formatRemaining(remainingMs!)}
            </p>
          </div>
        ) : null}

        {countdownDone ? (
          <div className="mt-8 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-900 sm:px-5">
            We&apos;re finishing the upgrade. The site may come back online shortly.
          </div>
        ) : null}

        <div className="mt-10 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm leading-6 text-slate-600 sm:px-5">
          Normal access returns automatically when maintenance mode is turned off
          in our deployment settings.
        </div>

        <form onSubmit={onUnlock} className="mt-10 space-y-4 border-t border-slate-200 pt-10">
          <p className="text-sm font-medium text-slate-800">Operator access</p>
          <p className="text-sm text-slate-600">
            If your team configured a maintenance password, enter it to continue testing.
          </p>
          <label className="block">
            <span className="sr-only">Password</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-900 shadow-sm outline-none ring-sky-500/30 placeholder:text-slate-400 focus:border-sky-400 focus:ring-2"
              placeholder="Maintenance password"
              disabled={busy}
            />
          </label>
          {error ? (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy || !password.trim()}
            className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Checking…" : "Unlock app"}
          </button>
        </form>
      </div>
    </main>
  );
}

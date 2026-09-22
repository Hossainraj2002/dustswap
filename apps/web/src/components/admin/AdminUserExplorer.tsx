"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  downloadAdminUserCsv,
  fetchAdminUserSummary,
  searchAdminUsers,
  type AdminUserQuery,
  type AdminUserRow,
  type AdminUserSearchResult,
  type AdminUserSummary,
} from "@/lib/adminUsers";

// Shares the session key with the quests admin page, so unlocking one unlocks the other
// for the rest of the browser session.
const TOKEN_SESSION_KEY = "quest-admin-token";

// Total fees and net fees sit right after PP rather than at the far right, because they are
// the two figures the page exists to answer and the table is wider than most screens.
const COLUMNS: Array<{
  key: keyof AdminUserRow;
  label: string;
  kind: "text" | "int" | "usd" | "date";
  /** Omitted when the column cannot be ordered server-side. */
  sort?: string;
  strong?: boolean;
}> = [
  { key: "user_id", label: "ID", kind: "int", sort: "user_id" },
  { key: "wallet", label: "Wallet", kind: "text", sort: "wallet" },
  { key: "x_name", label: "X", kind: "text", sort: "x_name" },
  { key: "discord_name", label: "Discord", kind: "text", sort: "discord_name" },
  { key: "pp_points", label: "PP", kind: "int", sort: "pp_points" },
  { key: "total_fees_paid_usd", label: "Total fees $", kind: "usd", sort: "total_fees_paid_usd", strong: true },
  { key: "net_after_all_rewards_usd", label: "Total net fees $", kind: "usd", sort: "net_after_all_rewards_usd", strong: true },
  { key: "total_rewards_received_usd", label: "Rewards $", kind: "usd", sort: "total_rewards_received_usd" },
  { key: "swap_count", label: "Swaps", kind: "int", sort: "swap_count" },
  { key: "swap_volume_usd", label: "Swap vol $", kind: "usd", sort: "swap_volume_usd" },
  { key: "swap_fees_paid_usd", label: "Swap fees $", kind: "usd", sort: "swap_fees_paid_usd" },
  { key: "sweep_count", label: "Sweeps", kind: "int", sort: "sweep_count" },
  { key: "sweep_gross_usd", label: "Sweep gross $", kind: "usd", sort: "sweep_gross_usd" },
  { key: "sweep_fees_paid_usd", label: "Sweep fees $", kind: "usd", sort: "sweep_fees_paid_usd" },
  { key: "sweep_rewards_received_usd", label: "Sweep reward $", kind: "usd", sort: "sweep_rewards_received_usd" },
  { key: "sweep_fees_net_of_rewards_usd", label: "Sweep net $", kind: "usd", sort: "sweep_fees_net_of_rewards_usd" },
  { key: "streak_save_count", label: "Saves", kind: "int", sort: "streak_save_count" },
  { key: "streak_save_fees_paid_usd", label: "Streak Save $", kind: "usd", sort: "streak_save_fees_paid_usd" },
  { key: "checkin_count", label: "Check-ins", kind: "int", sort: "checkin_count" },
  { key: "checkin_fees_paid_usd", label: "Check-in $", kind: "usd", sort: "checkin_fees_paid_usd" },
  { key: "spin_count", label: "Spins", kind: "int", sort: "spin_count" },
  { key: "spin_points_won", label: "Spin PP", kind: "int", sort: "spin_points_won" },
  { key: "partner_rewards_received_usd", label: "Partner $", kind: "usd", sort: "partner_rewards_received_usd" },
  { key: "current_streak", label: "Streak", kind: "int", sort: "current_streak" },
  { key: "last_check_in", label: "Last check-in", kind: "date", sort: "last_check_in" },
  { key: "last_activity", label: "Last active", kind: "text" },
];

const SORTS = COLUMNS.filter((c) => c.sort).map((c) => ({ value: c.sort as string, label: c.label }));

const EMPTY_QUERY: AdminUserQuery = {
  identifiers: "",
  identifierMode: "auto",
  sort: "pp_points",
  direction: "desc",
  limit: 50,
  offset: 0,
};

function fmtInt(v: unknown) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
}

function fmtUsd(v: unknown) {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortWallet(w: string) {
  return w ? `${w.slice(0, 6)}…${w.slice(-4)}` : "";
}

export function AdminUserExplorer() {
  const [adminToken, setAdminToken] = useState("");
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [query, setQuery] = useState<AdminUserQuery>(EMPTY_QUERY);
  const [result, setResult] = useState<AdminUserSearchResult | null>(null);
  const [summary, setSummary] = useState<AdminUserSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(TOKEN_SESSION_KEY);
      if (stored) setAdminToken(stored);
    } catch {
      /* private mode */
    }
  }, []);

  const runSearch = useCallback(
    async (token: string, next: AdminUserQuery) => {
      if (!token) return;
      setIsLoading(true);
      setError(null);
      const response = await searchAdminUsers(token, next);
      setIsLoading(false);
      if (!response.success || !response.data) {
        setError(response.error || "Search failed");
        if (response.error === "Unauthorized") setIsUnlocked(false);
        return;
      }
      setIsUnlocked(true);
      setResult(response.data);
      try {
        window.sessionStorage.setItem(TOKEN_SESSION_KEY, token);
      } catch {
        /* private mode */
      }
    },
    []
  );

  const unlock = useCallback(async () => {
    const token = adminToken.trim();
    if (!token) return;
    await runSearch(token, { ...query, offset: 0 });
    const s = await fetchAdminUserSummary(token);
    if (s.success && s.data) setSummary(s.data);
  }, [adminToken, query, runSearch]);

  const update = useCallback(<K extends keyof AdminUserQuery>(key: K, value: AdminUserQuery[K]) => {
    setQuery((prev) => ({ ...prev, [key]: value, offset: key === "offset" ? (value as number) : 0 }));
  }, []);

  const search = useCallback(
    (overrides: Partial<AdminUserQuery> = {}) => {
      const next = { ...query, ...overrides };
      setQuery(next);
      void runSearch(adminToken.trim(), next);
    },
    [adminToken, query, runSearch]
  );

  /** Click a header: same column flips direction, a new column starts high to low. */
  const toggleSort = useCallback(
    (sortKey: string) => {
      const sameColumn = query.sort === sortKey;
      const direction: "asc" | "desc" =
        sameColumn && query.direction === "desc" ? "asc" : sameColumn ? "desc" : "desc";
      search({ sort: sortKey, direction, offset: 0 });
    },
    [query.sort, query.direction, search]
  );

  const exportCsv = useCallback(async () => {
    setIsExporting(true);
    setNotice(null);
    setError(null);
    const err = await downloadAdminUserCsv(adminToken.trim(), query);
    setIsExporting(false);
    if (err) setError(err);
    else setNotice("CSV downloaded.");
  }, [adminToken, query]);

  const pageInfo = useMemo(() => {
    if (!result) return null;
    const from = result.total === 0 ? 0 : result.offset + 1;
    const to = Math.min(result.offset + result.rows.length, result.total);
    return { from, to, total: result.total };
  }, [result]);

  const totals = useMemo(() => {
    if (!result) return null;
    const sum = (k: keyof AdminUserRow) =>
      result.rows.reduce((acc, r) => acc + Number(r[k] ?? 0), 0);
    return {
      fees: sum("total_fees_paid_usd"),
      rewards: sum("total_rewards_received_usd"),
      net: sum("net_after_all_rewards_usd"),
    };
  }, [result]);

  if (!isUnlocked) {
    return (
      <section className="mx-auto mt-16 w-full max-w-md rounded-[28px] border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-600">
          DustSwap admin
        </p>
        <h1 className="mt-3 text-2xl font-semibold text-gray-900">User explorer</h1>
        <p className="mt-3 text-sm leading-6 text-gray-600">
          Enter the admin password to look up accounts, filter by what they paid, and download
          the result.
        </p>
        <input
          type="password"
          value={adminToken}
          onChange={(e) => setAdminToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void unlock();
          }}
          placeholder="Admin password"
          autoComplete="off"
          className="mt-5 w-full rounded-2xl border border-gray-200 px-4 py-3 text-sm outline-none focus:border-sky-400"
        />
        <button
          type="button"
          onClick={() => void unlock()}
          disabled={!adminToken.trim() || isLoading}
          className="mt-3 w-full rounded-2xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:opacity-50"
        >
          {isLoading ? "Checking…" : "Unlock"}
        </button>
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      </section>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5 px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-600">
            DustSwap admin
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-gray-900">User explorer</h1>
        </div>
        {summary ? (
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-600">
            <div>
              <dt className="inline font-semibold text-gray-900">{fmtInt(summary.accounts)}</dt>{" "}
              <span>accounts</span>
            </div>
            <div>
              <dt className="inline font-semibold text-gray-900">{fmtInt(summary.x_linked)}</dt>{" "}
              <span>X linked</span>
            </div>
            <div>
              <dt className="inline font-semibold text-gray-900">{fmtInt(summary.discord_linked)}</dt>{" "}
              <span>Discord linked</span>
            </div>
            <div>
              <dt className="inline font-semibold text-gray-900">
                ${fmtUsd(
                  Number(summary.swap_fees_usd) +
                    Number(summary.sweep_fees_usd) +
                    Number(summary.streak_fees_usd) +
                    Number(summary.checkin_fees_usd ?? 0) +
                    Number(summary.footprint_fees_usd ?? 0)
                )}
              </dt>{" "}
              <span>fees all time</span>
            </div>
          </dl>
        ) : null}
      </header>

      <section className="rounded-[28px] border border-gray-200 bg-white p-5 shadow-sm">
        <div className="grid gap-5 lg:grid-cols-[1.1fr_1.4fr]">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Search by wallet, X, Discord or user ID
            </label>
            <textarea
              value={query.identifiers ?? ""}
              onChange={(e) => update("identifiers", e.target.value)}
              rows={5}
              placeholder={"0xabc…\n@somehandle\ndiscorduser\n12345"}
              className="mt-2 w-full rounded-2xl border border-gray-200 px-4 py-3 font-mono text-xs outline-none focus:border-sky-400"
            />
            <p className="mt-2 text-xs text-gray-500">
              One per line, or separated by commas or spaces. Mix types freely.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["auto", "wallet", "x", "discord", "user_id"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => update("identifierMode", m)}
                  className={`rounded-full border px-3 py-1 text-xs transition ${
                    query.identifierMode === m
                      ? "border-sky-500 bg-sky-50 font-semibold text-sky-700"
                      : "border-gray-200 text-gray-600 hover:border-gray-300"
                  }`}
                >
                  {m === "user_id" ? "user id" : m}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <NumField label="PP min" value={query.ppMin} onChange={(v) => update("ppMin", v)} />
            <NumField label="PP max" value={query.ppMax} onChange={(v) => update("ppMax", v)} />
            <NumField
              label="Min total fees $"
              value={query.minTotalFees}
              onChange={(v) => update("minTotalFees", v)}
            />
            <NumField
              label="Min swap fees $"
              value={query.minSwapFees}
              onChange={(v) => update("minSwapFees", v)}
            />
            <NumField
              label="Min sweep fees $"
              value={query.minSweepFees}
              onChange={(v) => update("minSweepFees", v)}
            />
            <NumField
              label="Min Streak Saves"
              value={query.minStreakSaves}
              onChange={(v) => update("minStreakSaves", v)}
            />
            <NumField
              label="Min swaps"
              value={query.minSwapCount}
              onChange={(v) => update("minSwapCount", v)}
            />
            <NumField
              label="Min sweeps"
              value={query.minSweepCount}
              onChange={(v) => update("minSweepCount", v)}
            />
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Socials
              </label>
              <div className="mt-2 flex gap-2">
                <TriToggle label="X" value={query.hasX} onChange={(v) => update("hasX", v)} />
                <TriToggle
                  label="DC"
                  value={query.hasDiscord}
                  onChange={(v) => update("hasDiscord", v)}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-gray-100 pt-4">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Sort by
            </label>
            <select
              value={query.sort}
              onChange={(e) => update("sort", e.target.value)}
              className="mt-2 rounded-2xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-sky-400"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Order
            </label>
            <select
              value={query.direction}
              onChange={(e) => update("direction", e.target.value as "asc" | "desc")}
              className="mt-2 rounded-2xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-sky-400"
            >
              <option value="desc">High to low</option>
              <option value="asc">Low to high</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Rows
            </label>
            <select
              value={query.limit}
              onChange={(e) => update("limit", Number(e.target.value))}
              className="mt-2 rounded-2xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-sky-400"
            >
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => search({ offset: 0 })}
            disabled={isLoading}
            className="rounded-2xl bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:opacity-50"
          >
            {isLoading ? "Searching…" : "Search"}
          </button>
          <button
            type="button"
            onClick={() => void exportCsv()}
            disabled={isExporting || isLoading}
            className="rounded-2xl border border-gray-300 px-5 py-2.5 text-sm font-semibold text-gray-700 transition hover:border-gray-400 disabled:opacity-50"
          >
            {isExporting ? "Preparing…" : "Download CSV"}
          </button>
          <button
            type="button"
            onClick={() => {
              setQuery(EMPTY_QUERY);
              void runSearch(adminToken.trim(), EMPTY_QUERY);
            }}
            className="rounded-2xl px-3 py-2.5 text-sm text-gray-500 transition hover:text-gray-800"
          >
            Reset
          </button>
        </div>

        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm text-emerald-700">{notice}</p> : null}
      </section>

      {result ? (
        <section className="rounded-[28px] border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3 text-xs text-gray-600">
            <span>
              {pageInfo ? (
                <>
                  Showing <strong className="text-gray-900">{fmtInt(pageInfo.from)}</strong>–
                  <strong className="text-gray-900">{fmtInt(pageInfo.to)}</strong> of{" "}
                  <strong className="text-gray-900">{fmtInt(pageInfo.total)}</strong>
                </>
              ) : null}
              {result.identifiersParsed > 0
                ? ` · ${fmtInt(result.identifiersParsed)} identifiers searched`
                : ""}
              {` · ${fmtInt(result.tookMs)} ms`}
            </span>
            {totals ? (
              <span>
                This page: fees{" "}
                <strong className="text-gray-900">${fmtUsd(totals.fees)}</strong> · rewards{" "}
                <strong className="text-gray-900">${fmtUsd(totals.rewards)}</strong> · net{" "}
                <strong className="text-gray-900">${fmtUsd(totals.net)}</strong>
              </span>
            ) : null}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[2100px] border-collapse text-sm">
              <thead>
                <tr>
                  {COLUMNS.map((col) => {
                    const active = col.sort && query.sort === col.sort;
                    const arrow = active ? (query.direction === "asc" ? "▲" : "▼") : "";
                    return (
                      <th
                        key={String(col.key)}
                        aria-sort={
                          active ? (query.direction === "asc" ? "ascending" : "descending") : "none"
                        }
                        className={`whitespace-nowrap border-b border-gray-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide ${
                          col.kind === "text" ? "text-left" : "text-right"
                        } ${active ? "text-sky-600" : "text-gray-500"}`}
                      >
                        {col.sort ? (
                          <button
                            type="button"
                            onClick={() => toggleSort(col.sort as string)}
                            disabled={isLoading}
                            title={`Sort by ${col.label}`}
                            className={`inline-flex items-center gap-1 uppercase tracking-wide transition hover:text-sky-600 disabled:opacity-60 ${
                              col.kind === "text" ? "" : "flex-row-reverse"
                            }`}
                          >
                            <span>{col.label}</span>
                            <span className="w-2 text-[9px] leading-none">{arrow}</span>
                          </button>
                        ) : (
                          col.label
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.user_id} className="hover:bg-gray-50">
                    {COLUMNS.map((col) => {
                      const raw = row[col.key];
                      let content: string;
                      if (col.key === "wallet") content = shortWallet(String(raw ?? ""));
                      else if (col.kind === "usd") content = fmtUsd(raw);
                      else if (col.kind === "int") content = fmtInt(raw);
                      else if (col.kind === "date") content = raw ? String(raw).slice(0, 10) : "—";
                      else content = raw == null || raw === "" ? "—" : String(raw);
                      return (
                        <td
                          key={String(col.key)}
                          title={col.key === "wallet" ? String(raw ?? "") : undefined}
                          className={`whitespace-nowrap border-b border-gray-100 px-3 py-2 tabular-nums ${
                            col.kind === "text" ? "text-left" : "text-right"
                          } ${col.key === "wallet" ? "font-mono text-xs" : ""} ${col.strong ? "font-semibold" : ""}`}
                        >
                          {content}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {result.rows.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMNS.length} className="px-4 py-10 text-center text-sm text-gray-500">
                      Nothing matched those filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-gray-100 px-5 py-3">
            <button
              type="button"
              disabled={result.offset <= 0 || isLoading}
              onClick={() => search({ offset: Math.max(result.offset - result.limit, 0) })}
              className="rounded-2xl border border-gray-300 px-4 py-2 text-sm text-gray-700 transition hover:border-gray-400 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={result.offset + result.rows.length >= result.total || isLoading}
              onClick={() => search({ offset: result.offset + result.limit })}
              className="rounded-2xl border border-gray-300 px-4 py-2 text-sm text-gray-700 transition hover:border-gray-400 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </section>
      ) : null}

      <p className="px-1 text-xs leading-5 text-gray-500">
        Click any column heading to sort by it; click again to flip the direction. Fees are derived, not stored. Swap uses the on-chain referrer rate (20.0 bps to
        2026-06-21, 22.5 bps after), sweep uses the chain-verified credit where one exists and
        200 bps of gross otherwise, and Streak Save is the $1 recorded per payment. Every amount
        is the value on the day of the transaction. Spins and check-ins are counts, not charges.
      </p>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
}) {
  return (
    <div>
      <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</label>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className="mt-2 w-full rounded-2xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-sky-400"
      />
    </div>
  );
}

function TriToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null | undefined;
  onChange: (v: boolean | null) => void;
}) {
  const next = value === null || value === undefined ? true : value === true ? false : null;
  const text = value === true ? `${label} yes` : value === false ? `${label} no` : `${label} any`;
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      className={`rounded-full border px-3 py-2 text-xs transition ${
        value === true
          ? "border-emerald-500 bg-emerald-50 font-semibold text-emerald-700"
          : value === false
            ? "border-red-400 bg-red-50 font-semibold text-red-700"
            : "border-gray-200 text-gray-600 hover:border-gray-300"
      }`}
    >
      {text}
    </button>
  );
}

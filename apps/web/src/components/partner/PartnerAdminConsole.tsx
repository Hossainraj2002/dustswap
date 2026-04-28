"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchPartnerAdminLeaderboard,
  formatUsd,
  formatUtcDate,
  savePartnerAdminMember,
  shortAddress,
  type PartnerAdminLeaderboardResponse,
  type PartnerAdminLeaderboardRow,
} from "@/lib/partner";

const PARTNER_ADMIN_TOKEN_STORAGE_KEY = "partner-admin-token";

function getDisplayError(error: unknown) {
  const message = (error as Error)?.message || "Request failed";
  if (message === "Failed to fetch") {
    return "Could not reach the partner API. Check NEXT_PUBLIC_API_URL and the API deployment.";
  }
  return message;
}

function SummaryCard({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <div className="rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4 shadow-sm">
      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-black tracking-tight text-slate-950">{value}</p>
      <p className="mt-2 text-xs leading-5 text-slate-500">{caption}</p>
    </div>
  );
}

function LeaderboardTable({
  rows,
  emptyLabel,
}: {
  rows: PartnerAdminLeaderboardRow[];
  emptyLabel: string;
}) {
  if (!rows.length) {
    return (
      <div className="rounded-[24px] border border-dashed border-slate-200 bg-slate-50 px-5 py-6 text-sm leading-7 text-slate-600">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[24px] border border-slate-200">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr className="text-left text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
              <th className="px-4 py-3">Partner</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Share</th>
              <th className="px-4 py-3">Users</th>
              <th className="px-4 py-3">Current Week</th>
              <th className="px-4 py-3">Latest Closed Due</th>
              <th className="px-4 py-3">Unpaid</th>
              <th className="px-4 py-3">All-Time Reward</th>
              <th className="px-4 py-3">Profile</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white text-sm text-slate-700">
            {rows.map((row) => (
              <tr key={row.member.address}>
                <td className="px-4 py-4 align-top">
                  <p className="font-mono font-semibold text-slate-900">
                    {shortAddress(row.member.address)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {row.member.referralCode}
                  </p>
                </td>
                <td className="px-4 py-4 align-top">
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.16em] ${
                      row.member.status === "joined"
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-amber-50 text-amber-700"
                    }`}
                  >
                    {row.member.status}
                  </span>
                  <p className="mt-2 text-xs text-slate-500">
                    WL {formatUtcDate(row.member.whitelistedAt)}
                  </p>
                </td>
                <td className="px-4 py-4 align-top">
                  <p className="font-semibold text-slate-900">
                    {row.member.currentFeeSharePercent.toFixed(2)}%
                  </p>
                </td>
                <td className="px-4 py-4 align-top">
                  <p className="font-semibold text-slate-900">
                    {row.metrics.referredUsersTotal} joined
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {row.metrics.tradedUsersTotal} traded
                  </p>
                </td>
                <td className="px-4 py-4 align-top">
                  <p className="font-semibold text-slate-900">
                    {formatUsd(row.metrics.rewardCurrentWeekUsd)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {formatUsd(row.metrics.qualifyingVolumeCurrentWeekUsd)} volume
                  </p>
                </td>
                <td className="px-4 py-4 align-top">
                  <p className="font-semibold text-slate-900">
                    {formatUsd(row.metrics.latestClosedWeekDueRewardUsd)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {row.metrics.latestClosedWeekStartUtc || "No closed week"}
                  </p>
                </td>
                <td className="px-4 py-4 align-top">
                  <p className="font-semibold text-slate-900">
                    {formatUsd(row.metrics.unpaidRewardUsdTotal)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {row.metrics.unpaidClosedWeeks} week{row.metrics.unpaidClosedWeeks === 1 ? "" : "s"}
                  </p>
                </td>
                <td className="px-4 py-4 align-top">
                  <p className="font-semibold text-slate-900">
                    {formatUsd(row.metrics.rewardAllTimeUsd)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {formatUsd(row.metrics.qualifyingVolumeAllTimeUsd)} volume
                  </p>
                </td>
                <td className="px-4 py-4 align-top">
                  <Link
                    href={`/admin/partner/${encodeURIComponent(row.member.address)}`}
                    className="inline-flex rounded-[14px] bg-slate-950 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-white transition hover:bg-slate-800"
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PartnerAdminConsole({
  mode,
}: {
  mode: "overview" | "manager";
}) {
  const [adminToken, setAdminToken] = useState("");
  const [data, setData] = useState<PartnerAdminLeaderboardResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [search, setSearch] = useState("");
  const [formAddress, setFormAddress] = useState("");
  const [formFeeSharePercent, setFormFeeSharePercent] = useState("50");
  const [formIsAdmin, setFormIsAdmin] = useState(false);

  const loadLeaderboard = useCallback(
    async (tokenOverride?: string) => {
      const tokenToUse = tokenOverride || adminToken;
      if (!tokenToUse) {
        return;
      }

      setIsLoading(true);
      setError(null);
      setStatus(null);
      try {
        const response = await fetchPartnerAdminLeaderboard(tokenToUse);
        if (!response.success) {
          throw new Error(response.error || "Failed to load partner leaderboard");
        }

        setData(response);
        setIsUnlocked(true);
        setStatus("Partner admin unlocked.");
      } catch (loadError) {
        setIsUnlocked(false);
        setData(null);
        setError(getDisplayError(loadError));
      } finally {
        setIsLoading(false);
      }
    },
    [adminToken]
  );

  useEffect(() => {
    const saved = window.sessionStorage.getItem(PARTNER_ADMIN_TOKEN_STORAGE_KEY);
    if (saved) {
      setAdminToken(saved);
      void loadLeaderboard(saved);
    }
  }, [loadLeaderboard]);

  useEffect(() => {
    if (adminToken) {
      window.sessionStorage.setItem(PARTNER_ADMIN_TOKEN_STORAGE_KEY, adminToken);
      return;
    }

    window.sessionStorage.removeItem(PARTNER_ADMIN_TOKEN_STORAGE_KEY);
    setIsUnlocked(false);
    setData(null);
  }, [adminToken]);

  const filteredRows = useMemo(() => {
    const rows = data?.rows || [];
    const query = search.trim().toLowerCase();
    if (!query) {
      return rows;
    }

    return rows.filter((row) => {
      return (
        row.member.address.includes(query) ||
        row.member.referralCode.toLowerCase().includes(query)
      );
    });
  }, [data?.rows, search]);

  const summary = useMemo(() => {
    const rows = data?.rows || [];
    return {
      totalPartners: rows.length,
      joinedPartners: rows.filter((row) => row.member.status === "joined").length,
      pendingPartners: rows.filter((row) => row.member.status !== "joined").length,
      unpaidRewardUsd: rows.reduce(
        (sum, row) => sum + row.metrics.unpaidRewardUsdTotal,
        0
      ),
      currentWeekRewardUsd: rows.reduce(
        (sum, row) => sum + row.metrics.rewardCurrentWeekUsd,
        0
      ),
    };
  }, [data?.rows]);

  async function handleSaveMember() {
    if (!adminToken || !isUnlocked) {
      setError("Load the admin with a valid token first.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setStatus(null);

    try {
      const feeSharePercent = Number(formFeeSharePercent);
      const response = await savePartnerAdminMember(adminToken, {
        address: formAddress.trim(),
        feeSharePercent,
        isAdmin: formIsAdmin,
      });

      if (!response.success) {
        throw new Error(response.error || "Failed to save partner member");
      }

      setStatus(`Partner member saved for ${response.member.address}.`);
      setFormAddress(response.member.address);
      setFormFeeSharePercent(response.member.currentFeeSharePercent.toString());
      setFormIsAdmin(response.member.isAdmin);
      await loadLeaderboard();
    } catch (saveError) {
      setError(getDisplayError(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  function applyRowToForm(row: PartnerAdminLeaderboardRow) {
    setFormAddress(row.member.address);
    setFormFeeSharePercent(row.member.currentFeeSharePercent.toString());
    setFormIsAdmin(row.member.isAdmin);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6">
      <section className="rounded-[32px] border border-white/80 bg-white/88 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
        <p className="text-[11px] font-black uppercase tracking-[0.28em] text-sky-600">
          {mode === "overview" ? "Admin Overview" : "Partner Manager"}
        </p>
        <h1 className="mt-3 text-3xl font-black tracking-tight text-slate-950">
          {mode === "overview"
            ? "Monitor partner payouts and jump into each profile"
            : "Whitelist partners, update fee share, and manage weekly payouts"}
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
          Hidden admin surface for the DustSwap Partner Program. The leaderboard is
          sorted by the latest closed-week reward still due, so the payout queue stays
          easy to monitor before you distribute fees.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href="/admin/partner"
            className="inline-flex rounded-[16px] bg-slate-950 px-4 py-2.5 text-sm font-black text-white transition hover:bg-slate-800"
          >
            Open Partner Manager
          </Link>
          <Link
            href="/admin/quests"
            className="inline-flex rounded-[16px] border border-slate-200 bg-white px-4 py-2.5 text-sm font-black text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
          >
            Open Quest Admin
          </Link>
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <label className="block text-sm font-semibold text-slate-900">Admin token</label>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          This partner admin uses <code className="rounded bg-sky-50 px-1.5 py-0.5 text-sky-700">PARTNER_ADMIN_TOKEN</code> from the API environment.
        </p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <input
            value={adminToken}
            onChange={(event) => {
              setAdminToken(event.target.value);
              setIsUnlocked(false);
            }}
            placeholder="Paste PARTNER_ADMIN_TOKEN"
            className="w-full rounded-[18px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none ring-0 transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
          />
          <button
            type="button"
            onClick={() => void loadLeaderboard()}
            disabled={!adminToken || isLoading}
            className="rounded-[18px] bg-sky-600 px-5 py-3 text-sm font-black text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? "Loading..." : "Load Admin"}
          </button>
        </div>
      </section>

      {status ? (
        <div className="rounded-[18px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {status}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      {!isUnlocked ? (
        <section className="rounded-[28px] border border-dashed border-slate-200 bg-slate-50 p-6 text-sm leading-7 text-slate-600">
          Enter the valid partner admin token to unlock the leaderboard, partner drill-down,
          whitelist controls, and payout tools.
        </section>
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              label="Partners"
              value={summary.totalPartners.toString()}
              caption={`${summary.joinedPartners} joined, ${summary.pendingPartners} pending signature.`}
            />
            <SummaryCard
              label="Open Week Reward"
              value={formatUsd(summary.currentWeekRewardUsd)}
              caption={`Current UTC week starts ${data?.currentWeekStartUtc || "--"}.`}
            />
            <SummaryCard
              label="Unpaid Reward"
              value={formatUsd(summary.unpaidRewardUsd)}
              caption="Closed-week reward still waiting for payout marking."
            />
            <SummaryCard
              label="Next Distribution"
              value={formatUtcDate(data?.nextDistributionAt || null)}
              caption="UTC Monday 00:00 payout boundary."
            />
          </section>

          {mode === "manager" ? (
            <section className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
              <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-[11px] font-black uppercase tracking-[0.24em] text-sky-600">
                  Whitelist + Share
                </p>
                <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                  Add partner wallet or update fee share
                </h2>
                <div className="mt-5 space-y-4">
                  <label className="block">
                    <span className="text-sm font-semibold text-slate-900">Wallet address</span>
                    <input
                      value={formAddress}
                      onChange={(event) => setFormAddress(event.target.value)}
                      placeholder="0x..."
                      className="mt-2 w-full rounded-[18px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none ring-0 transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm font-semibold text-slate-900">Fee share percent</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={formFeeSharePercent}
                      onChange={(event) => setFormFeeSharePercent(event.target.value)}
                      className="mt-2 w-full rounded-[18px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none ring-0 transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                    />
                  </label>
                  <label className="flex items-center gap-3 rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={formIsAdmin}
                      onChange={(event) => setFormIsAdmin(event.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                    />
                    Mark this partner row as internal admin
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleSaveMember()}
                    disabled={!formAddress.trim() || isSaving}
                    className="inline-flex rounded-[18px] bg-slate-950 px-5 py-3 text-sm font-black text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSaving ? "Saving..." : "Save Partner"}
                  </button>
                </div>
              </div>

              <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-[11px] font-black uppercase tracking-[0.24em] text-sky-600">
                  Queue Notes
                </p>
                <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                  How this admin surface behaves
                </h2>
                <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-600">
                  <li>Whitelisting creates the partner’s DustSwap user record immediately so the referral code already exists.</li>
                  <li>Changing fee share is forward-only and starts a new effective interval from the save time.</li>
                  <li>Open-week values stay read-only until the week closes; payouts are marked from the individual partner profile.</li>
                  <li>The table stays sorted by the latest closed-week reward still due so weekly distribution work stays visible first.</li>
                </ul>
              </div>
            </section>
          ) : null}

          <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.24em] text-sky-600">
                  Partner Leaderboard
                </p>
                <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                  All partner accounts, newest payout pressure first
                </h2>
              </div>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search wallet or referral code"
                className="w-full rounded-[18px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none ring-0 transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100 sm:max-w-xs"
              />
            </div>

            {mode === "manager" && filteredRows.length ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {filteredRows.slice(0, 8).map((row) => (
                  <button
                    key={`${row.member.address}-edit`}
                    type="button"
                    onClick={() => applyRowToForm(row)}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-black uppercase tracking-[0.14em] text-slate-700 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700"
                  >
                    Edit {shortAddress(row.member.address)}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="mt-5">
              <LeaderboardTable
                rows={filteredRows}
                emptyLabel="No partner rows match this search yet."
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

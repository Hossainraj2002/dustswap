"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchPartnerAdminMember,
  formatFeeShareRange,
  formatUsd,
  formatUsdc,
  formatUtcDate,
  formatWeekLabel,
  markPartnerDistributionPaid,
  shortAddress,
  type PartnerAdminMemberDetailResponse,
} from "@/lib/partner";
import {
  fetchProfileSettings,
  resolveProfileDisplay,
  type ProfileSettingsResponse,
} from "@/lib/profileSettings";

const PARTNER_ADMIN_TOKEN_STORAGE_KEY = "partner-admin-token";

function getDisplayError(error: unknown) {
  const message = (error as Error)?.message || "Request failed";
  if (message === "Failed to fetch") {
    return "Could not reach the partner API. Check NEXT_PUBLIC_API_URL and the API deployment.";
  }
  return message;
}

function getSubmissionPlatformLabel(platform?: string | null) {
  if (platform === "x") {
    return "X";
  }

  if (platform === "telegram") {
    return "Telegram";
  }

  return "Other";
}

function MetricCard({
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

export function PartnerAdminMemberPage({
  address,
}: {
  address: string;
}) {
  const [adminToken, setAdminToken] = useState("");
  const [data, setData] = useState<PartnerAdminMemberDetailResponse | null>(null);
  const [profileSettings, setProfileSettings] = useState<ProfileSettingsResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [savingWeek, setSavingWeek] = useState<string | null>(null);
  const [isWalletCopied, setIsWalletCopied] = useState(false);
  const [payoutAmounts, setPayoutAmounts] = useState<Record<string, string>>({});
  const [txHashes, setTxHashes] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const profileDisplay = useMemo(
    () =>
      resolveProfileDisplay({
        settings: profileSettings,
        neynarProfile: null,
        address,
      }),
    [address, profileSettings]
  );

  const loadMember = useCallback(
    async (tokenOverride?: string) => {
      const tokenToUse = tokenOverride || adminToken;
      if (!tokenToUse) {
        return;
      }

      setIsLoading(true);
      setError(null);
      setStatus(null);
      try {
        const [response, nextProfileSettings] = await Promise.all([
          fetchPartnerAdminMember(tokenToUse, address),
          fetchProfileSettings(address).catch(() => null),
        ]);
        if (!response.success) {
          throw new Error(response.error || "Failed to load partner profile");
        }

        setData(response);
        setProfileSettings(nextProfileSettings);
        setIsUnlocked(true);
        setPayoutAmounts((current) => {
          const next = { ...current };
          for (const row of response.history) {
            if (!(row.weekStartUtc in next)) {
              next[row.weekStartUtc] = row.rewardUsd.toFixed(2);
            }
          }
          return next;
        });
      } catch (loadError) {
        setData(null);
        setProfileSettings(null);
        setIsUnlocked(false);
        setError(getDisplayError(loadError));
      } finally {
        setIsLoading(false);
      }
    },
    [address, adminToken]
  );

  useEffect(() => {
    const saved = window.sessionStorage.getItem(PARTNER_ADMIN_TOKEN_STORAGE_KEY);
    if (saved) {
      setAdminToken(saved);
      void loadMember(saved);
    }
  }, [loadMember]);

  useEffect(() => {
    if (adminToken) {
      window.sessionStorage.setItem(PARTNER_ADMIN_TOKEN_STORAGE_KEY, adminToken);
      return;
    }

    window.sessionStorage.removeItem(PARTNER_ADMIN_TOKEN_STORAGE_KEY);
    setIsUnlocked(false);
    setData(null);
    setProfileSettings(null);
  }, [adminToken]);

  async function handleMarkPaid(weekStartUtc: string) {
    if (!adminToken || !isUnlocked) {
      setError("Load the admin with a valid token first.");
      return;
    }

    setSavingWeek(weekStartUtc);
    setError(null);
    setStatus(null);
    try {
      const response = await markPartnerDistributionPaid(adminToken, {
        address,
        weekStartUtc,
        payoutUsdcAmount: Number(payoutAmounts[weekStartUtc] || "0"),
        payoutTxHash: txHashes[weekStartUtc] || "",
        paidNotes: notes[weekStartUtc] || null,
      });

      if (!response.success) {
        throw new Error(response.error || "Failed to mark payout as paid");
      }

      setStatus(`Marked ${weekStartUtc} as paid.`);
      await loadMember();
    } catch (saveError) {
      setError(getDisplayError(saveError));
    } finally {
      setSavingWeek(null);
    }
  }

  async function handleCopyWallet() {
    try {
      await navigator.clipboard.writeText(data?.member.address || address);
      setIsWalletCopied(true);
      setStatus("Wallet copied.");
      window.setTimeout(() => setIsWalletCopied(false), 1600);
    } catch {
      setError("Could not copy the wallet address.");
    }
  }

  const pendingRows = data?.history.filter((row) => row.status === "pending") || [];

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6">
      <section className="rounded-[32px] border border-white/80 bg-white/88 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            {profileDisplay.avatarUrl ? (
              <img
                src={profileDisplay.avatarUrl}
                alt="Partner profile"
                className="h-16 w-16 rounded-[20px] border border-white/80 object-cover shadow-[0_12px_30px_rgba(56,189,248,0.16)]"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-[20px] border border-sky-200 bg-[linear-gradient(135deg,#0ea5e9,#2563eb)] text-xl font-black text-white shadow-[0_12px_30px_rgba(37,99,235,0.2)]">
                {profileDisplay.initials}
              </div>
            )}

            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.28em] text-sky-600">
                Partner Profile
              </p>
              <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
                {profileDisplay.displayName}
              </h1>
              <p className="mt-1 text-sm text-slate-500">{profileDisplay.subtitle}</p>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
                Individual partner drill-down for whitelist status, fee share, weekly payout
                history, referred-user performance, and ambassador content submissions.
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-xs font-semibold text-slate-700">
                  {data?.member.address || address}
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopyWallet()}
                  className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                >
                  {isWalletCopied ? "Copied" : "Copy wallet"}
                </button>
                <span
                  className={`inline-flex rounded-full px-3 py-1.5 text-xs font-black ${
                    profileSettings?.profile.xConnected
                      ? "border border-sky-200 bg-sky-50 text-sky-700"
                      : "border border-slate-200 bg-slate-50 text-slate-600"
                  }`}
                >
                  {profileSettings?.profile.xConnected
                    ? `X @${profileSettings.profile.xUsername || "connected"}`
                    : "X not connected"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/admin"
              className="inline-flex rounded-[16px] border border-slate-200 bg-white px-4 py-2.5 text-sm font-black text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
            >
              Back to Admin
            </Link>
            <Link
              href="/admin/partner"
              className="inline-flex rounded-[16px] bg-slate-950 px-4 py-2.5 text-sm font-black text-white transition hover:bg-slate-800"
            >
              Back to Partner Manager
            </Link>
          </div>
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <label className="block text-sm font-semibold text-slate-900">Admin token</label>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Load this profile with the same <code className="rounded bg-sky-50 px-1.5 py-0.5 text-sky-700">PARTNER_ADMIN_TOKEN</code> used on the other hidden admin pages.
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
            onClick={() => void loadMember()}
            disabled={!adminToken || isLoading}
            className="rounded-[18px] bg-sky-600 px-5 py-3 text-sm font-black text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? "Loading..." : "Load Profile"}
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

      {!isUnlocked || !data ? (
        <section className="rounded-[28px] border border-dashed border-slate-200 bg-slate-50 p-6 text-sm leading-7 text-slate-600">
          Load the valid admin token to view this partner profile, payout history, and referred-user breakdown.
        </section>
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Status"
              value={data.member.status}
              caption={`Whitelisted ${formatUtcDate(data.member.whitelistedAt)}`}
            />
            <MetricCard
              label="Fee Share"
              value={`${data.member.currentFeeSharePercent.toFixed(2)}%`}
              caption={data.member.joinedAt ? `Joined ${formatUtcDate(data.member.joinedAt)}` : "Waiting for partner signature."}
            />
            <MetricCard
              label="Current Week Reward"
              value={formatUsd(data.metrics.rewardCurrentWeekUsd)}
              caption={`${formatUsd(data.metrics.qualifyingVolumeCurrentWeekUsd)} qualifying volume this week.`}
            />
            <MetricCard
              label="Unpaid Queue"
              value={formatUsd(data.metrics.unpaidRewardUsdTotal)}
              caption={`${data.metrics.unpaidClosedWeeks} closed week${data.metrics.unpaidClosedWeeks === 1 ? "" : "s"} waiting to be marked paid.`}
            />
            <MetricCard
              label="Users Joined"
              value={data.metrics.referredUsersTotal.toLocaleString()}
              caption={`${data.metrics.tradedUsersTotal} referred users have qualifying trades.`}
            />
            <MetricCard
              label="All-Time Volume"
              value={formatUsd(data.metrics.qualifyingVolumeAllTimeUsd)}
              caption="Qualifying volume counted from whitelist/referral/share-effective dates."
            />
            <MetricCard
              label="All-Time Reward"
              value={formatUsd(data.metrics.rewardAllTimeUsd)}
              caption={`Latest closed week reward ${formatUsd(data.metrics.latestClosedWeekRewardUsd)}.`}
            />
            <MetricCard
              label="Next Distribution"
              value={formatUtcDate(data.nextDistributionAt)}
              caption="UTC Monday 00:00 payout boundary."
            />
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.24em] text-sky-600">
                  Content
                </p>
                <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                  Partner content submissions
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Review the ambassador’s submitted DustSwap content links from X, Telegram,
                  and other public posts.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                    This month
                  </p>
                  <p className="mt-1 text-lg font-black text-slate-950">
                    {data.submissionSummary.currentMonthTotal}
                  </p>
                </div>
                <div className="rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                    Total
                  </p>
                  <p className="mt-1 text-lg font-black text-slate-950">
                    {data.submissionSummary.total}
                  </p>
                </div>
              </div>
            </div>

            {data.submissions.length ? (
              <div className="mt-5 space-y-3">
                {data.submissions.map((row) => (
                  <div
                    key={row.id}
                    className="rounded-[22px] border border-slate-200 bg-slate-50/80 px-4 py-4"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-sky-700">
                            {getSubmissionPlatformLabel(row.platform)}
                          </span>
                          <span className="text-xs text-slate-500">
                            {formatUtcDate(row.submittedAt)}
                          </span>
                        </div>
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 block break-all text-sm font-semibold text-slate-900 hover:text-sky-700"
                        >
                          {row.url}
                        </a>
                      </div>
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex shrink-0 rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-sm font-black text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                      >
                        Open link
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-5 rounded-[24px] border border-dashed border-slate-200 bg-slate-50 px-5 py-6 text-sm leading-7 text-slate-600">
                This partner has not submitted any DustSwap content links yet.
              </div>
            )}
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-[11px] font-black uppercase tracking-[0.24em] text-sky-600">
              Weekly Payouts
            </p>
            <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
              Closed-week reward rows and payment marking
            </h2>

            {data.history.length ? (
              <div className="mt-5 overflow-hidden rounded-[24px] border border-slate-200">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50">
                      <tr className="text-left text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
                        <th className="px-4 py-3">Week</th>
                        <th className="px-4 py-3">Volume</th>
                        <th className="px-4 py-3">Reward</th>
                        <th className="px-4 py-3">Share</th>
                        <th className="px-4 py-3">Payout</th>
                        <th className="px-4 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 bg-white text-sm text-slate-700">
                      {data.history.map((row) => (
                        <tr key={row.weekStartUtc}>
                          <td className="px-4 py-4 align-top">
                            <p className="font-semibold text-slate-900">
                              {formatWeekLabel(row.weekStartUtc, row.weekEndUtc)}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {row.referredUsersTotal} joined, {row.tradedUsersTotal} traded
                            </p>
                          </td>
                          <td className="px-4 py-4 align-top">
                            <p className="font-semibold text-slate-900">
                              {formatUsd(row.qualifyingVolumeUsd)}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              Protocol fee {formatUsd(row.protocolFeeUsd)}
                            </p>
                          </td>
                          <td className="px-4 py-4 align-top">
                            <p className="font-semibold text-slate-900">
                              {formatUsd(row.rewardUsd)}
                            </p>
                          </td>
                          <td className="px-4 py-4 align-top">
                            {formatFeeShareRange(
                              row.minFeeSharePercent,
                              row.maxFeeSharePercent
                            )}
                          </td>
                          <td className="px-4 py-4 align-top">
                            {row.status === "paid" ? (
                              <>
                                <p className="font-semibold text-slate-900">
                                  {formatUsdc(row.payoutUsdcAmount)}
                                </p>
                                <p className="mt-1 text-xs text-slate-500">
                                  {formatUtcDate(row.paidAt)}
                                </p>
                                {row.payoutTxHash ? (
                                  <a
                                    href={`https://basescan.org/tx/${row.payoutTxHash}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="mt-2 inline-flex text-xs font-semibold text-sky-600 hover:text-sky-700"
                                  >
                                    View tx
                                  </a>
                                ) : null}
                              </>
                            ) : (
                              <div className="flex min-w-[260px] flex-col gap-2">
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={payoutAmounts[row.weekStartUtc] || ""}
                                  onChange={(event) =>
                                    setPayoutAmounts((current) => ({
                                      ...current,
                                      [row.weekStartUtc]: event.target.value,
                                    }))
                                  }
                                  placeholder="USDC amount"
                                  className="rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                                />
                                <input
                                  value={txHashes[row.weekStartUtc] || ""}
                                  onChange={(event) =>
                                    setTxHashes((current) => ({
                                      ...current,
                                      [row.weekStartUtc]: event.target.value,
                                    }))
                                  }
                                  placeholder="0x payout tx hash"
                                  className="rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                                />
                                <input
                                  value={notes[row.weekStartUtc] || ""}
                                  onChange={(event) =>
                                    setNotes((current) => ({
                                      ...current,
                                      [row.weekStartUtc]: event.target.value,
                                    }))
                                  }
                                  placeholder="Optional note"
                                  className="rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                                />
                                <button
                                  type="button"
                                  onClick={() => void handleMarkPaid(row.weekStartUtc)}
                                  disabled={
                                    savingWeek === row.weekStartUtc ||
                                    !txHashes[row.weekStartUtc]
                                  }
                                  className="rounded-[14px] bg-slate-950 px-3 py-2 text-sm font-black text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {savingWeek === row.weekStartUtc ? "Saving..." : "Mark Paid"}
                                </button>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-4 align-top">
                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.16em] ${
                                row.status === "paid"
                                  ? "bg-emerald-50 text-emerald-700"
                                  : "bg-amber-50 text-amber-700"
                              }`}
                            >
                              {row.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="mt-5 rounded-[24px] border border-dashed border-slate-200 bg-slate-50 px-5 py-6 text-sm leading-7 text-slate-600">
                No closed qualifying weeks yet for this partner.
              </div>
            )}

            {pendingRows.length ? (
              <p className="mt-4 text-xs leading-6 text-slate-500">
                Pending rows stay read-only on the member side until you mark them paid here with the sent USDC amount and payout tx hash.
              </p>
            ) : null}
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-[11px] font-black uppercase tracking-[0.24em] text-sky-600">
              Referred Users
            </p>
            <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
              Individual referred-user performance
            </h2>

            {data.referredUsers.length ? (
              <div className="mt-5 overflow-hidden rounded-[24px] border border-slate-200">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50">
                      <tr className="text-left text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
                        <th className="px-4 py-3">Wallet</th>
                        <th className="px-4 py-3">Referral Activated</th>
                        <th className="px-4 py-3">Traded</th>
                        <th className="px-4 py-3">Current Week Volume</th>
                        <th className="px-4 py-3">All-Time Volume</th>
                        <th className="px-4 py-3">Current Week Reward</th>
                        <th className="px-4 py-3">All-Time Reward</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 bg-white text-sm text-slate-700">
                      {data.referredUsers.map((row) => (
                        <tr key={row.refereeUserId}>
                          <td className="px-4 py-4 align-top">
                            <p className="font-mono font-semibold text-slate-900">
                              {shortAddress(row.address)}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">{row.address}</p>
                          </td>
                          <td className="px-4 py-4 align-top">
                            {formatUtcDate(row.referralActivatedAt)}
                          </td>
                          <td className="px-4 py-4 align-top">
                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.16em] ${
                                row.hasQualifiedTrade
                                  ? "bg-emerald-50 text-emerald-700"
                                  : "bg-slate-100 text-slate-600"
                              }`}
                            >
                              {row.hasQualifiedTrade ? "yes" : "no"}
                            </span>
                          </td>
                          <td className="px-4 py-4 align-top">
                            {formatUsd(row.qualifyingVolumeCurrentWeekUsd)}
                          </td>
                          <td className="px-4 py-4 align-top">
                            {formatUsd(row.qualifyingVolumeAllTimeUsd)}
                          </td>
                          <td className="px-4 py-4 align-top">
                            {formatUsd(row.rewardCurrentWeekUsd)}
                          </td>
                          <td className="px-4 py-4 align-top">
                            {formatUsd(row.rewardAllTimeUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="mt-5 rounded-[24px] border border-dashed border-slate-200 bg-slate-50 px-5 py-6 text-sm leading-7 text-slate-600">
                This partner has no activated referred users yet.
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

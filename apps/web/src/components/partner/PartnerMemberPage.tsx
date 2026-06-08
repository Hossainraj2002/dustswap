"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { WalletConnectButton } from "@/components/wallet/WalletConnectButton";
import {
  buildPartnerContentSubmissionMessage,
  buildPartnerJoinMessage,
  fetchPartnerDashboard,
  fetchPartnerHistory,
  fetchPartnerSubmissions,
  formatFeeShareRange,
  formatUsd,
  formatUsdc,
  formatUtcDate,
  formatWeekLabel,
  getDistributionCountdown,
  joinPartnerProgram,
  shortAddress,
  type PartnerDashboardResponse,
  type PartnerHistoryResponse,
  type PartnerSubmissionsResponse,
  submitPartnerContent,
} from "@/lib/partner";
import { buildXAccountMessage, createXConnectUrl } from "@/lib/quests";
import {
  fetchProfileSettings,
  resolveProfileDisplay,
  type ProfileSettingsResponse,
} from "@/lib/profileSettings";

type NoticeState =
  | {
      kind: "success" | "error";
      message: string;
    }
  | null;

function getErrorMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "Request failed. Please try again.";
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
  accent,
}: {
  label: string;
  value: string;
  caption?: string;
  accent: "sky" | "amber" | "emerald";
}) {
  const accents = {
    sky: "border-sky-200 bg-sky-50 text-sky-900",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
  };

  return (
    <div className={`rounded-[24px] border px-4 py-4 shadow-sm ${accents[accent]}`}>
      <p className="text-[10px] font-black uppercase tracking-[0.22em] opacity-70">
        {label}
      </p>
      <p className="mt-2 text-2xl font-black tracking-tight">{value}</p>
      {caption ? (
        <p className="mt-2 text-xs leading-5 opacity-80">{caption}</p>
      ) : null}
    </div>
  );
}

function SectionCard({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[30px] border border-white/70 bg-white/86 px-5 py-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur sm:px-6 sm:py-6">
      <p className="text-[10px] font-black uppercase tracking-[0.28em] text-sky-600">
        {eyebrow}
      </p>
      <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function PartnerMemberPage() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [dashboard, setDashboard] = useState<PartnerDashboardResponse | null>(null);
  const [history, setHistory] = useState<PartnerHistoryResponse | null>(null);
  const [submissions, setSubmissions] = useState<PartnerSubmissionsResponse | null>(null);
  const [profileSettings, setProfileSettings] = useState<ProfileSettingsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSigning, setIsSigning] = useState(false);
  const [isConnectingX, setIsConnectingX] = useState(false);
  const [isSubmittingContent, setIsSubmittingContent] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [contentUrl, setContentUrl] = useState("");
  const [isSubmissionsOpen, setIsSubmissionsOpen] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [, setRefreshTick] = useState(0);

  const profileDisplay = useMemo(
    () =>
      resolveProfileDisplay({
        settings: profileSettings,
        neynarProfile: null,
        address,
      }),
    [address, profileSettings]
  );

  const countdown = getDistributionCountdown(
    dashboard?.nextDistributionAt || new Date().toISOString()
  );
  const isXConnected = profileSettings?.profile.xConnected === true;

  const loadData = useCallback(async () => {
    if (!address) {
      setDashboard(null);
      setHistory(null);
      setSubmissions(null);
      setProfileSettings(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const [dashboardResponse, historyResponse, settingsResponse, submissionsResponse] =
        await Promise.all([
        fetchPartnerDashboard(address),
        fetchPartnerHistory(address),
        fetchProfileSettings(address).catch(() => null),
        fetchPartnerSubmissions(address).catch(() => null),
      ]);

      setDashboard(dashboardResponse);
      setHistory(historyResponse);
      setProfileSettings(settingsResponse);
      setSubmissions(submissionsResponse?.success ? submissionsResponse : null);

      if (!dashboardResponse.success) {
        throw new Error(dashboardResponse.error || "Failed to load partner dashboard");
      }
      if (!historyResponse.success) {
        throw new Error(historyResponse.error || "Failed to load partner history");
      }
    } catch (error) {
      setNotice({
        kind: "error",
        message: getErrorMessage(error),
      });
    } finally {
      setIsLoading(false);
    }
  }, [address]);

  useEffect(() => {
    if (!isConnected) {
      setDashboard(null);
      setHistory(null);
      setSubmissions(null);
      setProfileSettings(null);
      setNotice(null);
      setIsLoading(false);
      return;
    }

    void loadData();
  }, [isConnected, loadData]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setRefreshTick((current) => current + 1);
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timeoutId = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  const handleJoin = useCallback(async () => {
    if (!address || !walletClient) {
      setNotice({
        kind: "error",
        message: "Connect the whitelisted wallet before joining the program.",
      });
      return;
    }

    setIsSigning(true);
    try {
      const message = buildPartnerJoinMessage(address);
      const signature = await walletClient.signMessage({
        account: address as `0x${string}`,
        message,
      });
      const result = await joinPartnerProgram({
        address,
        message,
        signature,
      });

      if (!result.success) {
        throw new Error(result.error || "Partner join verification failed.");
      }

      setNotice({
        kind: "success",
        message: "Partner program access unlocked.",
      });
      await loadData();
    } catch (error) {
      setNotice({
        kind: "error",
        message: getErrorMessage(error),
      });
    } finally {
      setIsSigning(false);
    }
  }, [address, loadData, walletClient]);

  const handleConnectX = useCallback(async () => {
    if (!address || !walletClient) {
      setNotice({
        kind: "error",
        message: "Connect the partner wallet first.",
      });
      return;
    }

    if (isConnectingX) {
      return;
    }

    setIsConnectingX(true);
    try {
      const message = buildXAccountMessage(address, "connect-x");
      const signature = await walletClient.signMessage({
        account: address as `0x${string}`,
        message,
      });
      const response = await createXConnectUrl({
        address,
        message,
        signature,
        returnTo:
          typeof window !== "undefined"
            ? new URL("/partner", window.location.origin).toString()
            : "/partner",
      });

      if (!response.success || !response.authUrl) {
        throw new Error(response.error || "Failed to start X connection.");
      }

      window.location.assign(response.authUrl);
    } catch (error) {
      setNotice({
        kind: "error",
        message: getErrorMessage(error),
      });
      setIsConnectingX(false);
    }
  }, [address, isConnectingX, walletClient]);

  const handleSubmitContent = useCallback(async () => {
    if (!address || !walletClient) {
      setNotice({
        kind: "error",
        message: "Connect the partner wallet first.",
      });
      return;
    }

    if (!dashboard?.member || dashboard.state !== "joined") {
      setNotice({
        kind: "error",
        message: "Finish partner access first before submitting content.",
      });
      return;
    }

    if (!isXConnected) {
      await handleConnectX();
      return;
    }

    setIsSubmittingContent(true);
    try {
      const message = buildPartnerContentSubmissionMessage(address, contentUrl);
      const signature = await walletClient.signMessage({
        account: address as `0x${string}`,
        message,
      });
      const result = await submitPartnerContent({
        address,
        message,
        signature,
        url: contentUrl,
      });

      setSubmissions(result);
      setContentUrl("");
      setIsSubmissionsOpen(true);
      setNotice({
        kind: "success",
        message: "Content link submitted.",
      });
    } catch (error) {
      setNotice({
        kind: "error",
        message: getErrorMessage(error),
      });
    } finally {
      setIsSubmittingContent(false);
    }
  }, [
    address,
    contentUrl,
    dashboard?.member,
    dashboard?.state,
    handleConnectX,
    isXConnected,
    walletClient,
  ]);

  useEffect(() => {
    if (!address || typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const xLinked = params.get("x_linked");
    const xError = params.get("x_error");
    const xUsername = params.get("x_username");

    if (!xLinked && !xError) {
      return;
    }

    if (xLinked === "1") {
      setNotice({
        kind: "success",
        message: xUsername ? `X connected as @${xUsername}.` : "X connected.",
      });
      void loadData();
    } else if (xError) {
      setNotice({
        kind: "error",
        message: xError || "X connection failed. Please try again.",
      });
      setIsConnectingX(false);
    }

    params.delete("x_linked");
    params.delete("x_error");
    params.delete("x_username");

    const nextUrl = `${window.location.pathname}${
      params.toString() ? `?${params.toString()}` : ""
    }${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, [address, loadData]);

  const referralLink = dashboard?.member?.referralLink || "";

  if (!isConnected) {
    return (
      <div
        className="theme-page relative overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.12),transparent_26%),radial-gradient(circle_at_bottom_right,rgba(251,191,36,0.12),transparent_22%),linear-gradient(180deg,#f8fbff,#fef7ed_46%,#eef6ff)] px-4 py-10"
        style={{ minHeight: "calc(100dvh - 4rem)" }}
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col items-center justify-center rounded-[34px] border border-white/80 bg-white/82 px-6 py-12 text-center shadow-[0_32px_96px_rgba(15,23,42,0.12)] backdrop-blur">
          <div className="rounded-full border border-sky-100 bg-sky-50 px-4 py-1 text-[11px] font-black uppercase tracking-[0.26em] text-sky-700">
            Hidden Partner Surface
          </div>
          <h1 className="mt-6 max-w-2xl text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
            Connect your whitelisted wallet to enter the DustSwap Partner Program
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-7 text-slate-600 sm:text-base">
            This dashboard is reserved for approved DustSwap partners. Connect the
            exact wallet address we whitelisted for your program access.
          </p>
          <div className="mt-8">
            <WalletConnectButton
              showDisconnect
              className="bg-[linear-gradient(135deg,#0284c7,#2563eb)] text-white shadow-[0_18px_36px_rgba(37,99,235,0.28)] hover:border-transparent hover:text-white"
              description="Connect the whitelisted wallet for your DustSwap partner dashboard."
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="theme-page bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.14),transparent_24%),linear-gradient(180deg,#f8fbff,#fef7ed_44%,#eef6ff)] px-4 py-5 pb-16 sm:px-6 sm:py-8"
      style={{ minHeight: "calc(100dvh - 4rem)" }}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        {notice ? (
          <div
            className={`rounded-[18px] border px-4 py-3 text-sm shadow-sm ${
              notice.kind === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-700"
            }`}
          >
            {notice.message}
          </div>
        ) : null}

        <section className="rounded-[32px] border border-white/80 bg-white/84 px-5 py-5 shadow-[0_28px_96px_rgba(15,23,42,0.08)] backdrop-blur sm:px-6 sm:py-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-center gap-4">
              {profileDisplay.avatarUrl ? (
                <img
                  src={profileDisplay.avatarUrl}
                  alt="Partner profile"
                  className="h-14 w-14 rounded-[18px] border border-white/80 object-cover shadow-[0_12px_30px_rgba(56,189,248,0.16)]"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded-[18px] border border-sky-200 bg-[linear-gradient(135deg,#0ea5e9,#2563eb)] text-xl font-black text-white shadow-[0_12px_30px_rgba(37,99,235,0.2)]">
                  {profileDisplay.initials}
                </div>
              )}
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.28em] text-sky-600">
                  DustSwap Partner Program
                </p>
                <h1 className="mt-1 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">
                  {profileDisplay.displayName}
                </h1>
                <p className="mt-1 text-sm text-slate-500">
                  {profileDisplay.subtitle}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">
                  Wallet
                </p>
                <p className="mt-1 font-mono text-sm font-bold text-slate-900">
                  {shortAddress(address)}
                </p>
              </div>
              <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">
                  Status
                </p>
                <p className="mt-1 text-sm font-black text-slate-900">
                  {isLoading
                    ? "Loading..."
                    : dashboard?.state === "joined"
                      ? "Joined"
                      : dashboard?.state === "pending_join"
                        ? "Whitelisted"
                        : "Not Whitelisted"}
                </p>
              </div>
              <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">
                  Fee Share
                </p>
                <p className="mt-1 text-sm font-black text-slate-900">
                  {dashboard?.member
                    ? `${dashboard.member.currentFeeSharePercent.toFixed(2)}%`
                    : "--"}
                </p>
              </div>
            </div>
          </div>

          {dashboard?.member ? (
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-[20px] border border-sky-100 bg-sky-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-sky-600">
                  Whitelisted
                </p>
                <p className="mt-1 text-sm font-semibold text-sky-950">
                  {formatUtcDate(dashboard.member.whitelistedAt)}
                </p>
              </div>
              <div className="rounded-[20px] border border-emerald-100 bg-emerald-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-600">
                  Joined
                </p>
                <p className="mt-1 text-sm font-semibold text-emerald-950">
                  {dashboard.member.joinedAt ? formatUtcDate(dashboard.member.joinedAt) : "Pending signature"}
                </p>
              </div>
              <div className="rounded-[20px] border border-amber-100 bg-amber-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-600">
                  Referral Code
                </p>
                <p className="mt-1 font-mono text-sm font-bold text-amber-950">
                  {dashboard.member.referralCode}
                </p>
              </div>
              <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                  Next Distribution
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {formatUtcDate(dashboard.nextDistributionAt)}
                </p>
              </div>
            </div>
          ) : null}
        </section>

        {dashboard?.state === "not_whitelisted" && !isLoading ? (
          <SectionCard eyebrow="Access" title="This wallet is not whitelisted">
            <div className="rounded-[24px] border border-amber-200 bg-[linear-gradient(180deg,#fff7ed,#fffaf4)] p-5">
              <p className="text-sm leading-7 text-slate-700">
                You are not whitelisted for partner program.
              </p>
              <p className="mt-3 text-sm leading-7 text-slate-700">
                Submit your application if you want to join the program by DM on X:
              </p>
              <a
                href="https://x.com/dustswaponbase"
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex items-center rounded-[16px] bg-[linear-gradient(135deg,#0f172a,#1d4ed8)] px-4 py-2.5 text-sm font-black text-white shadow-[0_14px_28px_rgba(29,78,216,0.18)] transition hover:-translate-y-0.5"
              >
                DM @dustswaponbase
              </a>
            </div>
          </SectionCard>
        ) : null}

        {dashboard?.state === "pending_join" && dashboard.member && !isLoading ? (
          <SectionCard eyebrow="Join" title="Complete your one-time partner verification">
            <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
              <div className="rounded-[24px] border border-sky-200 bg-[linear-gradient(180deg,#f0f9ff,#eef6ff)] p-5">
                <p className="text-sm leading-7 text-slate-700">
                  Your wallet is whitelisted and your referral code is ready. Sign once to
                  confirm this wallet for partner access, then your full dashboard will unlock.
                </p>
                <button
                  type="button"
                  onClick={() => void handleJoin()}
                  disabled={isSigning}
                  className="mt-5 inline-flex items-center rounded-[16px] bg-[linear-gradient(135deg,#0284c7,#2563eb)] px-5 py-3 text-sm font-black text-white shadow-[0_16px_32px_rgba(37,99,235,0.2)] transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSigning ? "Waiting for signature..." : "Verify by Signing"}
                </button>
              </div>

              <div className="rounded-[24px] border border-slate-200 bg-slate-50 p-5">
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-500">
                  What unlocks next
                </p>
                <ul className="mt-3 space-y-3 text-sm leading-6 text-slate-700">
                  <li>View the same referral link used on your DustSwap profile.</li>
                  <li>Track invited users, trading volume, and weekly reward progress.</li>
                  <li>See paid fee distributions and payout tx hashes in your history.</li>
                </ul>
              </div>
            </div>
          </SectionCard>
        ) : null}

        {dashboard?.state === "joined" && dashboard.member && !isLoading ? (
          <>
            <SectionCard eyebrow="Referral" title="Your partner referral link">
              <div className="rounded-[24px] border border-sky-100 bg-[linear-gradient(180deg,#f0f9ff,#eef6ff)] p-5">
                <p className="text-sm leading-7 text-slate-700">
                  This is the same referral link your wallet uses on the DustSwap profile page.
                </p>
                <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center">
                  <div className="flex-1 rounded-[18px] border border-slate-200 bg-white px-4 py-3">
                    <p className="break-all font-mono text-sm font-semibold text-slate-900">
                      {referralLink}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (!referralLink) {
                        return;
                      }
                      void navigator.clipboard.writeText(referralLink);
                      setIsCopied(true);
                      setNotice({
                        kind: "success",
                        message: "Partner referral link copied.",
                      });
                      window.setTimeout(() => setIsCopied(false), 1800);
                    }}
                    className="inline-flex items-center justify-center rounded-[16px] bg-slate-950 px-4 py-3 text-sm font-black text-white transition hover:bg-slate-800"
                  >
                    {isCopied ? "Copied" : "Copy Link"}
                  </button>
                </div>
              </div>
            </SectionCard>

            <section className="rounded-[24px] border border-white/80 bg-white/88 px-4 py-4 shadow-[0_18px_56px_rgba(15,23,42,0.06)] backdrop-blur">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-black uppercase tracking-[0.24em] text-sky-600">
                    Submit your content
                  </p>
                  <p className="mt-1 text-[11px] leading-4 text-slate-600">
                    Share your DustSwap content link. Ambassadors need at least 3 posts
                    monthly, with no upper limit.
                  </p>
                </div>

                <div className="rounded-[14px] border border-slate-200 bg-slate-50 px-2.5 py-2 text-right">
                  <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-500">
                    This month
                  </p>
                  <p className="mt-0.5 text-sm font-black tracking-tight text-slate-950">
                    {submissions?.summary.currentMonthTotal || 0}
                  </p>
                </div>
              </div>

              {isXConnected ? (
                <>
                  <div className="mt-3 flex items-center gap-2 rounded-[18px] border border-slate-200 bg-slate-50/70 p-2">
                    <input
                      value={contentUrl}
                      onChange={(event) => setContentUrl(event.target.value)}
                      placeholder="X tweet link / Tg post link / Others"
                      className="h-10 min-w-0 flex-1 rounded-[14px] border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                    />
                    <button
                      type="button"
                      onClick={() => void handleSubmitContent()}
                      disabled={isSubmittingContent}
                      className="inline-flex h-10 shrink-0 items-center justify-center rounded-[14px] bg-[linear-gradient(135deg,#0284c7,#2563eb)] px-3 text-sm font-black text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isSubmittingContent ? "Submitting..." : "Submit"}
                    </button>
                  </div>

                  <div className="mt-2 flex items-center justify-between gap-3">
                    <p className="text-[11px] text-slate-500">
                      {submissions?.summary.currentMonthTotal || 0} this month ·{" "}
                      {submissions?.summary.total || 0} total
                    </p>
                    <button
                      type="button"
                      onClick={() => setIsSubmissionsOpen((current) => !current)}
                      className="text-xs font-black text-sky-700 transition hover:text-sky-800"
                    >
                      {isSubmissionsOpen
                        ? "Hide your submissions -"
                        : "View your submissions +"}
                    </button>
                  </div>
                </>
              ) : (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-[18px] border border-amber-200 bg-amber-50/80 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-black text-amber-900">
                      Connect X to unlock partner content submissions.
                    </p>
                    <p className="mt-1 text-[11px] leading-4 text-amber-800">
                      This uses the same X connection shared across your profile, quests, and
                      the rest of the app.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleConnectX()}
                    disabled={isConnectingX}
                    className="inline-flex h-10 shrink-0 items-center justify-center rounded-[14px] bg-slate-950 px-3 text-sm font-black text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isConnectingX ? "Connecting..." : "Connect X"}
                  </button>
                </div>
              )}

              {isSubmissionsOpen ? (
                <div className="mt-3 border-t border-slate-200 pt-3">
                  {submissions?.rows?.length ? (
                    <div className="space-y-2">
                      {submissions.rows.map((row) => (
                        <div
                          key={row.id}
                          className="rounded-[18px] border border-slate-200 bg-slate-50/80 px-3 py-2.5"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="inline-flex rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-sky-700">
                              {getSubmissionPlatformLabel(row.platform)}
                            </span>
                            <span className="text-[11px] text-slate-500">
                              {formatUtcDate(row.submittedAt)}
                            </span>
                          </div>
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 block break-all text-sm font-semibold text-slate-900 hover:text-sky-700"
                          >
                            {row.url}
                          </a>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-[18px] border border-dashed border-slate-200 bg-slate-50 px-4 py-4 text-xs leading-6 text-slate-500">
                      No submissions yet. Your first approved content link can start here.
                    </div>
                  )}
                </div>
              ) : null}
            </section>

            <SectionCard eyebrow="Metrics" title="Partner performance">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <MetricCard
                  label="Users Joined"
                  value={dashboard.metrics.referredUsersTotal.toLocaleString()}
                  caption="Total valid users who joined using your referral link."
                  accent="sky"
                />
                <MetricCard
                  label="Users Traded"
                  value={dashboard.metrics.tradedUsersTotal.toLocaleString()}
                  caption="Distinct referred users with qualifying partner trades."
                  accent="amber"
                />
                <MetricCard
                  label="All-Time Volume"
                  value={formatUsd(dashboard.metrics.qualifyingVolumeAllTimeUsd)}
                  caption="Qualifying referred-user volume counted from partner eligibility dates."
                  accent="emerald"
                />
                <MetricCard
                  label="Current Week Volume"
                  value={formatUsd(dashboard.metrics.qualifyingVolumeCurrentWeekUsd)}
                  caption="Open UTC Monday-to-Monday partner week volume."
                  accent="sky"
                />
                <MetricCard
                  label="All-Time Reward"
                  value={formatUsd(dashboard.metrics.rewardAllTimeUsd)}
                  caption="Total reward value generated by your partner program activity."
                  accent="amber"
                />
                <MetricCard
                  label="Current Week Reward"
                  value={formatUsd(dashboard.metrics.rewardCurrentWeekUsd)}
                  caption="Reward value building for the current open week."
                  accent="emerald"
                />
                <MetricCard
                  label="Latest Closed Week"
                  value={formatUsd(dashboard.metrics.latestClosedWeekRewardUsd)}
                  caption={
                    dashboard.metrics.latestClosedWeekStartUtc
                      ? `Week of ${dashboard.metrics.latestClosedWeekStartUtc}`
                      : "No closed qualifying week yet."
                  }
                  accent="sky"
                />
                <MetricCard
                  label="Unpaid Reward"
                  value={formatUsd(dashboard.metrics.unpaidRewardUsdTotal)}
                  caption={`${dashboard.metrics.unpaidClosedWeeks} closed week${
                    dashboard.metrics.unpaidClosedWeeks === 1 ? "" : "s"
                  } pending payout.`}
                  accent="amber"
                />
                <MetricCard
                  label="Next Distribution"
                  value={`${String(countdown.days).padStart(2, "0")}d ${String(
                    countdown.hours
                  ).padStart(2, "0")}h ${String(countdown.minutes).padStart(2, "0")}m ${String(
                    countdown.seconds
                  ).padStart(2, "0")}s`}
                  caption="Countdown to the next UTC Monday 00:00 distribution window."
                  accent="emerald"
                />
              </div>
            </SectionCard>

            <SectionCard eyebrow="History" title="Fee distribution history">
              {history?.rows?.length ? (
                <div className="overflow-hidden rounded-[24px] border border-slate-200">
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
                        {history.rows.map((row) => (
                          <tr key={row.weekStartUtc}>
                            <td className="px-4 py-4 align-top">
                              <p className="font-semibold text-slate-900">
                                {formatWeekLabel(row.weekStartUtc, row.weekEndUtc)}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                Starts {row.weekStartUtc} UTC
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
                              <p className="mt-1 text-xs text-slate-500">
                                {row.tradedUsersTotal} traded users
                              </p>
                            </td>
                            <td className="px-4 py-4 align-top">
                              {formatFeeShareRange(
                                row.minFeeSharePercent,
                                row.maxFeeSharePercent
                              )}
                            </td>
                            <td className="px-4 py-4 align-top">
                              <p className="font-semibold text-slate-900">
                                {formatUsdc(row.payoutUsdcAmount)}
                              </p>
                              {row.payoutTxHash ? (
                                <a
                                  href={`https://basescan.org/tx/${row.payoutTxHash}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 inline-flex text-xs font-semibold text-sky-600 hover:text-sky-700"
                                >
                                  View tx
                                </a>
                              ) : (
                                <p className="mt-1 text-xs text-slate-500">Awaiting payout.</p>
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
                              <p className="mt-2 text-xs text-slate-500">
                                {row.paidAt ? formatUtcDate(row.paidAt) : "Will appear after admin payout."}
                              </p>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="rounded-[24px] border border-dashed border-slate-200 bg-slate-50 px-5 py-6 text-sm leading-7 text-slate-600">
                  No closed partner distributions yet. Once a qualifying week closes and gets
                  processed, it will appear here with the payout amount and tx hash.
                </div>
              )}
            </SectionCard>
          </>
        ) : null}
      </div>
    </div>
  );
}

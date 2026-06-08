"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { erc20Abi, getAddress, isAddress, type Hex } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { base } from "wagmi/chains";
import { useBaseChainSwitch } from "@/hooks/useBaseChainSwitch";
import { isUserRejectedRequest } from "@/lib/paymaster";
import { USDC_ADDRESS } from "@/lib/tokens";
import { WalletConnectButton } from "@/components/wallet/WalletConnectButton";
import {
  fetchPartnerAdminLeaderboard,
  formatUsd,
  formatUtcDate,
  removePendingPartnerMembers,
  savePartnerAdminMember,
  savePartnerAdminMembersBatch,
  settlePartnerDistribution,
  shortAddress,
  type PartnerAdminLeaderboardResponse,
  type PartnerAdminLeaderboardRow,
} from "@/lib/partner";

const PARTNER_ADMIN_TOKEN_STORAGE_KEY = "partner-admin-token";
const PENDING_PAYOUT_STORAGE_KEY = "partner-payout-pending-v1";

type PendingPayout = {
  address: string;
  weekStartUtc: string;
  txHash: string;
  amountUsd: number;
  createdAt: number;
};

function pendingPayoutKey(address: string, weekStartUtc: string) {
  return `${address.toLowerCase()}:${weekStartUtc}`;
}

function readPendingPayouts(): Record<string, PendingPayout> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(PENDING_PAYOUT_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, PendingPayout>) : {};
  } catch {
    return {};
  }
}

function writePendingPayouts(value: Record<string, PendingPayout>) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(PENDING_PAYOUT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage write failures (private mode / quota).
  }
}

function getDisplayError(error: unknown) {
  const message = (error as Error)?.message || "Request failed";
  if (message === "Failed to fetch") {
    return "Could not reach the partner API. Check NEXT_PUBLIC_API_URL and the API deployment.";
  }
  return message;
}

function extractUniqueAddresses(value: string) {
  const matches = value.match(/0x[a-fA-F0-9]{40}/g) || [];
  const deduped = new Map<string, string>();

  for (const match of matches) {
    if (!isAddress(match)) {
      continue;
    }

    const normalized = getAddress(match);
    const key = normalized.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  }

  return Array.from(deduped.values());
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

function PayCell({
  row,
  canPay,
  busy,
  anyBusy,
  pending,
  onPay,
}: {
  row: PartnerAdminLeaderboardRow;
  canPay: boolean;
  busy: boolean;
  anyBusy: boolean;
  pending?: PendingPayout;
  onPay: (row: PartnerAdminLeaderboardRow) => void;
}) {
  const dueUsd = row.metrics.latestClosedWeekDueRewardUsd;
  const weekStartUtc = row.metrics.latestClosedWeekStartUtc;
  const hasDue = Boolean(weekStartUtc) && dueUsd > 0;

  if (!pending && !hasDue) {
    return <span className="text-[11px] text-slate-400">Nothing due</span>;
  }

  const disabled = !canPay || anyBusy;
  const title = !canPay
    ? "Unlock the admin token and connect your payout wallet to pay."
    : undefined;

  if (pending) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => onPay(row)}
          disabled={disabled}
          title={title}
          className="inline-flex items-center justify-center rounded-[14px] border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-amber-800 transition hover:border-amber-400 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Finalizing..." : "Finalize payout"}
        </button>
        <a
          href={`https://basescan.org/tx/${pending.txHash}`}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] font-semibold text-sky-600 hover:text-sky-700"
        >
          Sent {formatUsd(pending.amountUsd)} · view tx
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => onPay(row)}
        disabled={disabled}
        title={title}
        className="inline-flex items-center justify-center rounded-[14px] bg-emerald-600 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Paying..." : `Pay ${formatUsd(dueUsd)}`}
      </button>
      <span className="text-[11px] text-slate-500">Week {weekStartUtc}</span>
    </div>
  );
}

function LeaderboardTable({
  rows,
  emptyLabel,
  canPay,
  payingAddress,
  pendingPayouts,
  onPay,
}: {
  rows: PartnerAdminLeaderboardRow[];
  emptyLabel: string;
  canPay: boolean;
  payingAddress: string | null;
  pendingPayouts: Record<string, PendingPayout>;
  onPay: (row: PartnerAdminLeaderboardRow) => void;
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
                  <div className="flex flex-col gap-2">
                    <Link
                      href={`/admin/partner/${encodeURIComponent(row.member.address)}`}
                      className="inline-flex justify-center rounded-[14px] bg-slate-950 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-white transition hover:bg-slate-800"
                    >
                      Open
                    </Link>
                    <PayCell
                      row={row}
                      canPay={canPay}
                      busy={payingAddress === row.member.address}
                      anyBusy={payingAddress !== null}
                      pending={
                        pendingPayouts[
                          pendingPayoutKey(
                            row.member.address,
                            row.metrics.latestClosedWeekStartUtc || ""
                          )
                        ]
                      }
                      onPay={onPay}
                    />
                  </div>
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
  const [formAddressInput, setFormAddressInput] = useState("");
  const [formFeeSharePercent, setFormFeeSharePercent] = useState("50");
  const [formIsAdmin, setFormIsAdmin] = useState(false);
  const [selectedPendingAddresses, setSelectedPendingAddresses] = useState<string[]>([]);
  const [removedPendingAddresses, setRemovedPendingAddresses] = useState<string[]>([]);
  const [isRemovingPending, setIsRemovingPending] = useState(false);
  const [isPendingCopied, setIsPendingCopied] = useState(false);
  const [isRemovedCopied, setIsRemovedCopied] = useState(false);

  const { address: walletAddress, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: base.id });
  const { isOnBase, isSwitching, switchToBase } = useBaseChainSwitch();
  const [payingAddress, setPayingAddress] = useState<string | null>(null);
  const [pendingPayouts, setPendingPayouts] = useState<Record<string, PendingPayout>>({});

  useEffect(() => {
    setPendingPayouts(readPendingPayouts());
  }, []);

  const persistPending = useCallback((key: string, payout: PendingPayout) => {
    setPendingPayouts((current) => {
      const next = { ...current, [key]: payout };
      writePendingPayouts(next);
      return next;
    });
  }, []);

  const clearPending = useCallback((key: string) => {
    setPendingPayouts((current) => {
      if (!(key in current)) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      writePendingPayouts(next);
      return next;
    });
  }, []);

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

  const pendingRows = useMemo(
    () => (data?.rows || []).filter((row) => row.member.status !== "joined"),
    [data?.rows]
  );

  const pendingAddressSet = useMemo(
    () => new Set(pendingRows.map((row) => row.member.address)),
    [pendingRows]
  );

  const pendingWalletText = useMemo(
    () => pendingRows.map((row) => row.member.address).join("\n"),
    [pendingRows]
  );

  const removedPendingWalletText = useMemo(
    () => removedPendingAddresses.join("\n"),
    [removedPendingAddresses]
  );

  const parsedAddresses = useMemo(
    () => extractUniqueAddresses(formAddressInput),
    [formAddressInput]
  );

  useEffect(() => {
    setSelectedPendingAddresses((current) =>
      current.filter((address) => pendingAddressSet.has(address))
    );
  }, [pendingAddressSet]);

  async function handleSaveMember() {
    if (!adminToken || !isUnlocked) {
      setError("Load the admin with a valid token first.");
      return;
    }

    if (!parsedAddresses.length) {
      setError("Paste at least one valid wallet address.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setStatus(null);

    try {
      const feeSharePercent = Number(formFeeSharePercent);
      if (parsedAddresses.length === 1) {
        const response = await savePartnerAdminMember(adminToken, {
          address: parsedAddresses[0],
          feeSharePercent,
          isAdmin: formIsAdmin,
        });

        if (!response.success) {
          throw new Error(response.error || "Failed to save partner member");
        }

        setStatus(`Partner member saved for ${response.member.address}.`);
        setFormAddressInput(response.member.address);
        setFormFeeSharePercent(response.member.currentFeeSharePercent.toString());
        setFormIsAdmin(response.member.isAdmin);
      } else {
        const response = await savePartnerAdminMembersBatch(adminToken, {
          addresses: parsedAddresses,
          feeSharePercent,
          isAdmin: formIsAdmin,
        });

        if (!response.success) {
          throw new Error(response.error || "Failed to save partner members");
        }

        setStatus(
          `Processed ${response.processedCount} partners. ${response.createdCount} new, ${response.updatedCount} updated.`
        );
        setFormAddressInput("");
      }
      await loadLeaderboard();
    } catch (saveError) {
      setError(getDisplayError(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  function togglePendingAddress(address: string) {
    setSelectedPendingAddresses((current) =>
      current.includes(address)
        ? current.filter((entry) => entry !== address)
        : [...current, address]
    );
  }

  function selectAllPendingAddresses() {
    setSelectedPendingAddresses(pendingRows.map((row) => row.member.address));
  }

  async function handleCopyPendingWallets() {
    if (!pendingWalletText) {
      setError("There are no pending wallet addresses to copy.");
      return;
    }

    try {
      await navigator.clipboard.writeText(pendingWalletText);
      setIsPendingCopied(true);
      setStatus("Pending whitelist wallet list copied.");
      window.setTimeout(() => setIsPendingCopied(false), 1600);
    } catch {
      setError("Could not copy pending wallet addresses.");
    }
  }

  async function handleCopyRemovedWallets() {
    if (!removedPendingWalletText) {
      setError("There are no removed wallet addresses to copy yet.");
      return;
    }

    try {
      await navigator.clipboard.writeText(removedPendingWalletText);
      setIsRemovedCopied(true);
      setStatus("Removed wallet list copied.");
      window.setTimeout(() => setIsRemovedCopied(false), 1600);
    } catch {
      setError("Could not copy removed wallet addresses.");
    }
  }

  async function handleRemovePendingWallets(addresses: string[]) {
    if (!adminToken || !isUnlocked) {
      setError("Load the admin with a valid token first.");
      return;
    }

    const uniqueAddresses = Array.from(new Set(addresses)).filter((address) =>
      pendingAddressSet.has(address)
    );

    if (!uniqueAddresses.length) {
      setError("Select at least one pending whitelist wallet first.");
      return;
    }

    const confirmed = window.confirm(
      `Remove ${uniqueAddresses.length} pending whitelist wallet${
        uniqueAddresses.length === 1 ? "" : "s"
      }? Joined partners are protected and will be skipped.`
    );

    if (!confirmed) {
      return;
    }

    setIsRemovingPending(true);
    setError(null);
    setStatus(null);

    try {
      const response = await removePendingPartnerMembers(adminToken, {
        addresses: uniqueAddresses,
      });

      if (!response.success) {
        throw new Error(response.error || "Failed to remove pending whitelist wallets");
      }

      const removedAddressSet = new Set(response.removedAddresses);
      setRemovedPendingAddresses(response.removedAddresses);
      setSelectedPendingAddresses((current) =>
        current.filter((address) => !removedAddressSet.has(address))
      );
      await loadLeaderboard();
      setStatus(
        response.removedCount
          ? `Removed ${response.removedCount} pending whitelist wallet${
              response.removedCount === 1 ? "" : "s"
            }. ${response.skippedCount} skipped.`
          : "No pending whitelist wallets were removed."
      );
    } catch (removeError) {
      setError(getDisplayError(removeError));
    } finally {
      setIsRemovingPending(false);
    }
  }

  async function finalizePayout(row: PartnerAdminLeaderboardRow, txHash: Hex) {
    const partnerAddress = row.member.address;
    const weekStartUtc = row.metrics.latestClosedWeekStartUtc || "";
    const key = pendingPayoutKey(partnerAddress, weekStartUtc);

    setStatus(`Recording payout for ${shortAddress(partnerAddress)}…`);

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await settlePartnerDistribution(adminToken, {
          address: partnerAddress,
          weekStartUtc,
          payoutTxHash: txHash,
          paidNotes: walletAddress
            ? `Paid from ${walletAddress} via admin Pay button`
            : "Paid via admin Pay button",
        });

        if (!response.success) {
          throw new Error(response.error || "Failed to record payout.");
        }

        clearPending(key);
        setStatus(
          `Paid ${shortAddress(partnerAddress)} and marked week ${weekStartUtc} as paid.`
        );
        await loadLeaderboard();
        return;
      } catch (settleError) {
        lastError = settleError;
        await new Promise((resolve) => window.setTimeout(resolve, 2500));
      }
    }

    // The transfer is already on-chain and saved locally; the partner row will now
    // show "Finalize payout" so the admin can retry recording without paying twice.
    throw new Error(
      `Payment was sent on-chain but recording it failed: ${getDisplayError(lastError)} ` +
        `It is saved locally — click "Finalize payout" on this partner to retry without paying again.`
    );
  }

  async function handlePayPartner(row: PartnerAdminLeaderboardRow) {
    const partnerAddress = row.member.address;
    const weekStartUtc = row.metrics.latestClosedWeekStartUtc || "";
    const dueUsd = row.metrics.latestClosedWeekDueRewardUsd;
    const key = pendingPayoutKey(partnerAddress, weekStartUtc);
    const existingPending = weekStartUtc ? pendingPayouts[key] : undefined;

    setError(null);
    setStatus(null);

    if (!adminToken || !isUnlocked) {
      setError("Load the admin with a valid token first.");
      return;
    }
    if (!isConnected || !walletAddress || !walletClient) {
      setError("Connect your payout wallet first.");
      return;
    }
    if (!publicClient) {
      setError("Base RPC is unavailable right now. Refresh and try again.");
      return;
    }

    setPayingAddress(partnerAddress);
    try {
      // Resume an interrupted payout: finalize the existing tx instead of re-paying.
      if (existingPending) {
        await finalizePayout(row, existingPending.txHash as Hex);
        return;
      }

      if (!weekStartUtc || dueUsd <= 0) {
        throw new Error("No closed-week amount is currently due for this partner.");
      }

      const confirmed = window.confirm(
        `Send ${dueUsd.toFixed(2)} USDC on Base to this partner?\n\n` +
          `Partner: ${partnerAddress}\n` +
          `Week: ${weekStartUtc}\n` +
          `From: ${walletAddress}\n\n` +
          `This sends USDC directly from your connected wallet, then marks the week paid.`
      );
      if (!confirmed) {
        return;
      }

      if (!isOnBase) {
        setStatus("Switching your wallet to Base…");
        await switchToBase();
      }

      const amountUnits = BigInt(Math.round(dueUsd * 1_000_000));
      if (amountUnits <= 0n) {
        throw new Error("Computed payout amount is zero.");
      }

      const balance = (await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress as `0x${string}`],
      })) as bigint;

      if (balance < amountUnits) {
        throw new Error(
          `Your wallet holds ${(Number(balance) / 1_000_000).toFixed(2)} USDC but ` +
            `${dueUsd.toFixed(2)} USDC is needed for this payout.`
        );
      }

      setStatus(`Confirm the ${dueUsd.toFixed(2)} USDC transfer in your wallet…`);
      const txHash = (await walletClient.writeContract({
        account: walletAddress as `0x${string}`,
        chain: base,
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "transfer",
        args: [partnerAddress as `0x${string}`, amountUnits],
      })) as Hex;

      // Persist BEFORE waiting so a refresh/crash resumes finalize and never double-pays.
      persistPending(key, {
        address: partnerAddress,
        weekStartUtc,
        txHash,
        amountUsd: dueUsd,
        createdAt: Date.now(),
      });

      setStatus(`Payment sent (${txHash.slice(0, 10)}…). Waiting for confirmation…`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        throw new Error("The USDC transfer reverted on-chain. The week was not marked paid.");
      }

      await finalizePayout(row, txHash);
    } catch (payError) {
      if (isUserRejectedRequest(payError)) {
        setStatus(null);
        setError("Payment cancelled in your wallet.");
      } else {
        setError(getDisplayError(payError));
      }
    } finally {
      setPayingAddress(null);
    }
  }

  function applyRowToForm(row: PartnerAdminLeaderboardRow) {
    setFormAddressInput(row.member.address);
    setFormFeeSharePercent(row.member.currentFeeSharePercent.toString());
    setFormIsAdmin(row.member.isAdmin);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="theme-page mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6">
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
            <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.24em] text-amber-600">
                    Pending Signature WL
                  </p>
                  <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                    Whitelisted wallets that have not joined yet
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                    These wallets are on the partner whitelist but still have not signed
                    the join message. Removing here only deletes pending whitelist rows;
                    already joined partners are skipped by the API.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyPendingWallets()}
                    disabled={!pendingRows.length}
                    className="rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-slate-700 transition hover:border-amber-200 hover:bg-amber-50 hover:text-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isPendingCopied ? "Copied" : "Copy Pending"}
                  </button>
                  <button
                    type="button"
                    onClick={selectAllPendingAddresses}
                    disabled={!pendingRows.length}
                    className="rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-slate-700 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedPendingAddresses([])}
                    disabled={!selectedPendingAddresses.length}
                    className="rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRemovePendingWallets(selectedPendingAddresses)}
                    disabled={!selectedPendingAddresses.length || isRemovingPending}
                    className="rounded-[14px] bg-rose-600 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isRemovingPending
                      ? "Removing..."
                      : `Remove Selected (${selectedPendingAddresses.length})`}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void handleRemovePendingWallets(
                        pendingRows.map((row) => row.member.address)
                      )
                    }
                    disabled={!pendingRows.length || isRemovingPending}
                    className="rounded-[14px] border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Remove All Pending
                  </button>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <SummaryCard
                  label="Pending WL"
                  value={pendingRows.length.toString()}
                  caption="Wallets still waiting for the join signature."
                />
                <SummaryCard
                  label="Selected"
                  value={selectedPendingAddresses.length.toString()}
                  caption="Wallets queued for pending whitelist removal."
                />
                <SummaryCard
                  label="Last Removed"
                  value={removedPendingAddresses.length.toString()}
                  caption="Wallets available in the copy box below."
                />
              </div>

              {pendingRows.length ? (
                <div className="mt-5 overflow-hidden rounded-[24px] border border-slate-200">
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-slate-200">
                      <thead className="bg-slate-50">
                        <tr className="text-left text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
                          <th className="px-4 py-3">Pick</th>
                          <th className="px-4 py-3">Wallet</th>
                          <th className="px-4 py-3">Referral</th>
                          <th className="px-4 py-3">Share</th>
                          <th className="px-4 py-3">Whitelisted</th>
                          <th className="px-4 py-3">Users</th>
                          <th className="px-4 py-3">Remove</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 bg-white text-sm text-slate-700">
                        {pendingRows.map((row) => {
                          const isSelected = selectedPendingAddresses.includes(
                            row.member.address
                          );

                          return (
                            <tr key={`${row.member.address}-pending`}>
                              <td className="px-4 py-4 align-top">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => togglePendingAddress(row.member.address)}
                                  aria-label={`Select ${row.member.address}`}
                                  className="h-4 w-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                                />
                              </td>
                              <td className="px-4 py-4 align-top">
                                <p className="font-mono font-semibold text-slate-900">
                                  {row.member.address}
                                </p>
                                <p className="mt-1 text-xs text-slate-500">
                                  {shortAddress(row.member.address)}
                                </p>
                              </td>
                              <td className="px-4 py-4 align-top">
                                <p className="font-mono font-semibold text-slate-900">
                                  {row.member.referralCode}
                                </p>
                              </td>
                              <td className="px-4 py-4 align-top">
                                <p className="font-semibold text-slate-900">
                                  {row.member.currentFeeSharePercent.toFixed(2)}%
                                </p>
                              </td>
                              <td className="px-4 py-4 align-top">
                                {formatUtcDate(row.member.whitelistedAt)}
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
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleRemovePendingWallets([row.member.address])
                                  }
                                  disabled={isRemovingPending}
                                  className="rounded-[14px] border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="mt-5 rounded-[24px] border border-dashed border-slate-200 bg-slate-50 px-5 py-6 text-sm leading-7 text-slate-600">
                  No pending whitelist wallets right now. Every whitelisted partner has joined.
                </div>
              )}

              {removedPendingAddresses.length ? (
                <div className="mt-5 rounded-[24px] border border-emerald-200 bg-emerald-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-[11px] font-black uppercase tracking-[0.22em] text-emerald-700">
                        Removed Wallets
                      </p>
                      <p className="mt-1 text-sm leading-6 text-emerald-800">
                        Copy this latest removed batch before starting another cleanup.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleCopyRemovedWallets()}
                      className="rounded-[14px] bg-emerald-700 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-white transition hover:bg-emerald-800"
                    >
                      {isRemovedCopied ? "Copied" : "Copy Removed"}
                    </button>
                  </div>
                  <textarea
                    readOnly
                    value={removedPendingWalletText}
                    rows={Math.min(Math.max(removedPendingAddresses.length, 3), 10)}
                    className="mt-3 w-full resize-y rounded-[18px] border border-emerald-200 bg-white px-4 py-3 font-mono text-sm text-slate-900 outline-none"
                  />
                </div>
              ) : null}
            </section>
          ) : null}

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
                    <span className="text-sm font-semibold text-slate-900">
                      Wallet address or bulk paste
                    </span>
                    <textarea
                      value={formAddressInput}
                      onChange={(event) => setFormAddressInput(event.target.value)}
                      placeholder={"0x...\n0x...\nPaste many addresses, comma lists, or mixed text"}
                      rows={5}
                      className="mt-2 w-full resize-y rounded-[18px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none ring-0 transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>
                        Detects unique `0x...` addresses from any pasted text, commas, or new lines.
                      </span>
                      <span className="inline-flex rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 font-black uppercase tracking-[0.14em] text-sky-700">
                        {parsedAddresses.length} unique
                      </span>
                    </div>
                    {parsedAddresses.length ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {parsedAddresses.slice(0, 8).map((parsedAddress) => (
                          <span
                            key={parsedAddress}
                            className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-mono font-semibold text-slate-700"
                          >
                            {shortAddress(parsedAddress)}
                          </span>
                        ))}
                        {parsedAddresses.length > 8 ? (
                          <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                            +{parsedAddresses.length - 8} more
                          </span>
                        ) : null}
                      </div>
                    ) : null}
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
                    disabled={!parsedAddresses.length || isSaving}
                    className="inline-flex rounded-[18px] bg-slate-950 px-5 py-3 text-sm font-black text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSaving
                      ? "Saving..."
                      : parsedAddresses.length > 1
                        ? `Save ${parsedAddresses.length} Partners`
                        : "Save Partner"}
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
                  <li>Paste one or many wallets in any format and the admin extracts unique valid addresses automatically.</li>
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

            <div className="mt-4 flex flex-col gap-3 rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-500">
                  Payout wallet
                </p>
                <p className="mt-1 text-sm leading-6 text-slate-700">
                  {isConnected && walletAddress ? (
                    <>
                      Paying from{" "}
                      <span className="font-mono font-semibold text-slate-900">
                        {shortAddress(walletAddress)}
                      </span>{" "}
                      on{" "}
                      <span
                        className={
                          isOnBase
                            ? "font-semibold text-emerald-700"
                            : "font-semibold text-rose-600"
                        }
                      >
                        {isOnBase ? "Base" : "the wrong network"}
                      </span>
                      . Pay sends USDC straight to each partner, then marks the week paid.
                    </>
                  ) : (
                    "Connect the wallet you send USDC from to enable the per-partner Pay buttons."
                  )}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {isConnected && !isOnBase ? (
                  <button
                    type="button"
                    onClick={() => void switchToBase()}
                    disabled={isSwitching}
                    className="rounded-[14px] border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSwitching ? "Switching…" : "Switch to Base"}
                  </button>
                ) : null}
                <WalletConnectButton showDisconnect connectLabel="Connect payout wallet" />
              </div>
            </div>

            <div className="mt-5">
              <LeaderboardTable
                rows={filteredRows}
                emptyLabel="No partner rows match this search yet."
                canPay={isUnlocked && isConnected && Boolean(walletAddress)}
                payingAddress={payingAddress}
                pendingPayouts={pendingPayouts}
                onPay={(row) => void handlePayPartner(row)}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

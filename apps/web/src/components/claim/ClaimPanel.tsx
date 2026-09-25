"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ThemeLongLogo } from "@/components/ThemeLongLogo";
import { WalletConnectButton } from "@/components/wallet/WalletConnectButton";
import { fetchProfileSettings } from "@/lib/profileSettings";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { useBaseChainSwitch } from "@/hooks/useBaseChainSwitch";
import { useWalletConnection } from "@/hooks/useWalletConnection";
import { DATA_SUFFIX } from "@/lib/builderCode";
import { explorerTxUrl } from "@/lib/contracts";
import { BASE_CHAIN_ID } from "@/lib/tokens";
import {
  CLAIM_CRITERIA,
  CLAIM_DISTRIBUTOR_ABI,
  CLAIM_ENABLED,
  CLAIM_DISTRIBUTOR_ADDRESS,
  CLAIM_TOKEN_SYMBOL,
  PREVIEW_ADDRESS,
  PREVIEW_AMOUNT,
  PREVIEW_SCENARIOS,
  PREVIEW_STATS,
  PREVIEW_STATS_COMMUNITY,
  formatClaimAmount,
  formatUsdTotal,
  isClaimConfigured,
  isPreviewMode,
  loadClaimProof,
  loadEligibilityIndex,
  type ClaimProof,
  type ClaimStats,
  type PreviewScenario,
} from "@/lib/claim";

type Phase = "ready" | "checking" | "eligible" | "not-eligible" | "claiming" | "claimed";

type Allocation = { index: number; amount: bigint; proof: Hex[]; stats: ClaimStats | null };

/**
 * Read from the chain, not from config. Without these the page would happily send a claim after
 * the deadline and surface a raw revert, or send people to burn gas against a list that does not
 * match the deployed root.
 */
type ContractState = { deadline: bigint; root: Hex; funded: boolean };

const PREVIEW_TX = "0x9f1c4a7e5b2d8036c1a94e7f0d5b83c26a4f19e7d0b5c8a3f62e14d097b5a3c81";

const STEPS = ["Connect Wallet", "Check Eligibility", "Claim"] as const;

function short(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readScenarioFromUrl(): PreviewScenario {
  if (typeof window === "undefined") return "eligible";
  const requested = new URLSearchParams(window.location.search).get("scenario");
  return PREVIEW_SCENARIOS.find((o) => o.id === requested)?.id ?? "eligible";
}

export function ClaimPanel() {
  const preview = isPreviewMode();
  const { address, isConnected } = useAccount();
  const { openWalletModal } = useWalletConnection();
  const { isOnBase, switchToBase } = useBaseChainSwitch();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient();

  const [phase, setPhase] = useState<Phase>("ready");
  const [allocation, setAllocation] = useState<Allocation | null>(null);
  const [claimTx, setClaimTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scenario, setScenario] = useState<PreviewScenario>("eligible");
  const [previewConnected, setPreviewConnected] = useState(false);
  const [contract, setContract] = useState<ContractState | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);

  const previewContract = useMemo<ContractState>(() => {
    const now = Math.floor(Date.now() / 1000);
    return {
      deadline: BigInt(scenario === "window-closed" ? now - 86_400 : now + 90 * 86_400),
      root: "0x0" as Hex,
      funded: scenario !== "not-funded",
    };
  }, [scenario]);

  useEffect(() => {
    if (preview) setScenario(readScenarioFromUrl());
  }, [preview]);

  useEffect(() => {
    if (preview || !isClaimConfigured() || !publicClient) return;
    let cancelled = false;

    void (async () => {
      const base = { address: CLAIM_DISTRIBUTOR_ADDRESS, abi: CLAIM_DISTRIBUTOR_ABI } as const;
      try {
        const [deadline, root, funded] = await Promise.all([
          publicClient.readContract({ ...base, functionName: "claimDeadline" }),
          publicClient.readContract({ ...base, functionName: "merkleRoot" }),
          publicClient.readContract({ ...base, functionName: "isFullyFunded" }),
        ]);
        if (cancelled) return;
        setContract({ deadline: deadline as bigint, root: root as Hex, funded: funded as boolean });


        // A published list that does not match the deployed root would fail every proof.
        const index = await loadEligibilityIndex(root as string);
        if (!cancelled && index.root.toLowerCase() !== (root as string).toLowerCase()) {
          setBlocked("Temporarily unavailable.");
        }
      } catch {
        if (!cancelled) setBlocked("Temporarily unavailable.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [preview, publicClient]);

  useEffect(() => {
    if (!preview) return;
    setPhase("ready");
    setAllocation(null);
    setClaimTx(null);
    setError(null);
    setPreviewConnected(false);
  }, [preview, scenario]);

  useEffect(() => {
    if (preview) return;
    setPhase("ready");
    setAllocation(null);
    setClaimTx(null);
    setError(null);
  }, [address, preview]);

  const connected = preview ? previewConnected : isConnected;
  const shownAddress = preview ? PREVIEW_ADDRESS : address;

  const activeContract = preview ? previewContract : contract;
  const windowClosed = activeContract ? Date.now() / 1000 > Number(activeContract.deadline) : false;
  // Checking is free of the funding question. Only a data/contract mismatch stops it, because
  // then every proof would fail and the user would pay gas for nothing.
  const checkHold = preview ? null : blocked;

  // Claiming is gated separately: the pool must be funded AND claims must be switched on.
  const funded = activeContract ? activeContract.funded : false;
  const claimHold = !CLAIM_ENABLED
    ? "Claiming opens soon."
    : !funded
      ? "The pool is not funded yet."
      : null;

  const step = useMemo(() => {
    if (!connected) return 1;
    if (phase === "eligible" || phase === "claiming" || phase === "claimed") return 3;
    return 2;
  }, [connected, phase]);

  const handleConnect = useCallback(() => {
    if (preview) {
      setPreviewConnected(true);
      return;
    }
    openWalletModal();
  }, [openWalletModal, preview]);

  /** Zero value transaction to the distribution contract, carrying the builder-code suffix. */
  const handleCheck = useCallback(async () => {
    setError(null);
    setPhase("checking");

    if (preview) {
      await sleep(1400);
      if (scenario === "not-eligible") {
        setPhase("not-eligible");
        return;
      }
      setAllocation({
        index: 42,
        amount: scenario === "community" ? 10_000000n : PREVIEW_AMOUNT,
        proof: [],
        stats: scenario === "community" ? PREVIEW_STATS_COMMUNITY : PREVIEW_STATS,
      });
      setPhase(scenario === "already-claimed" ? "claimed" : "eligible");
      return;
    }

    if (!address || !walletClient || !publicClient) return;

    try {
      if (!isOnBase) {
        const switched = await switchToBase();
        if (!switched) throw new Error("Switch to Base to continue.");
      }

      const version = contract?.root;
      const index = await loadEligibilityIndex(version);
      const entry = index.entries[address.toLowerCase()];
      const proof: ClaimProof | null = entry
        ? await loadClaimProof(address as Address, version)
        : null;

      const data = proof
        ? encodeFunctionData({
            abi: CLAIM_DISTRIBUTOR_ABI,
            functionName: "checkEligibility",
            args: [BigInt(proof.i), BigInt(proof.a), proof.p],
          })
        : encodeFunctionData({
            abi: CLAIM_DISTRIBUTOR_ABI,
            functionName: "checkEligibility",
            args: [],
          });

      const hash = await walletClient.sendTransaction({
        to: CLAIM_DISTRIBUTOR_ADDRESS,
        data,
        dataSuffix: DATA_SUFFIX,
        value: 0n,
      } as never);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction failed.");

      if (!proof) {
        setPhase("not-eligible");
        return;
      }

      const claimed = (await publicClient.readContract({
        address: CLAIM_DISTRIBUTOR_ADDRESS,
        abi: CLAIM_DISTRIBUTOR_ABI,
        functionName: "isClaimed",
        args: [BigInt(proof.i)],
      })) as boolean;

      setAllocation({
        index: proof.i,
        amount: BigInt(proof.a),
        proof: proof.p,
        // Stats are optional. When the published proof omits them the totals block is hidden
        // rather than showing a misleading row of zeros.
        stats:
          proof.sv !== undefined && proof.wv !== undefined
            ? { sv: proof.sv, wv: proof.wv, ss: proof.ss ?? 0, cm: proof.cm ?? 0 }
            : null,
      });
      setPhase(claimed ? "claimed" : "eligible");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Something went wrong.";
      setError(/user rejected|denied/i.test(message) ? "Transaction cancelled." : message);
      setPhase("ready");
    }
  }, [address, contract, isOnBase, preview, publicClient, scenario, switchToBase, walletClient]);

  const handleClaim = useCallback(async () => {
    setError(null);
    setPhase("claiming");

    if (preview) {
      await sleep(1600);
      setClaimTx(PREVIEW_TX);
      setPhase("claimed");
      return;
    }

    if (!address || !walletClient || !publicClient || !allocation) return;

    try {
      if (!isOnBase) {
        const switched = await switchToBase();
        if (!switched) throw new Error("Switch to Base to continue.");
      }

      const data = encodeFunctionData({
        abi: CLAIM_DISTRIBUTOR_ABI,
        functionName: "claim",
        args: [BigInt(allocation.index), address as Address, allocation.amount, allocation.proof],
      });

      const hash = await walletClient.sendTransaction({
        to: CLAIM_DISTRIBUTOR_ADDRESS,
        data,
        dataSuffix: DATA_SUFFIX,
        value: 0n,
      } as never);

      setClaimTx(hash);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction failed.");

      setPhase("claimed");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Something went wrong.";
      setError(/user rejected|denied/i.test(message) ? "Transaction cancelled." : message);
      setPhase("eligible");
    }
  }, [address, allocation, isOnBase, preview, publicClient, switchToBase, walletClient]);

  const stats = allocation ? allocation.stats : PREVIEW_STATS;
  // The breakdown is only meaningful once the person has their own numbers.
  const showAnyStats =
    phase === "eligible" || phase === "claiming" || phase === "claimed";

  return (
    <div className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden bg-[#f4f7fc] px-5 py-12 dark:bg-[#070d1a]">
      <Backdrop />

      {preview ? <PreviewPills scenario={scenario} onChange={setScenario} /> : null}

      <div className="relative w-full max-w-[400px]">
        <ClaimHeader address={connected ? shownAddress ?? null : null} />

        <div className="rounded-[26px] border border-slate-200/80 bg-white/90 p-7 text-center shadow-[0_24px_70px_rgba(15,23,42,0.10)] backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.04] dark:shadow-[0_24px_70px_rgba(0,0,0,0.5)]">
          <Coin />

          <h1 className="mt-5 text-[26px] font-semibold tracking-tight text-slate-900 dark:text-white">
            Claim {CLAIM_TOKEN_SYMBOL}
          </h1>

          <Stepper current={step} failed={phase === "not-eligible"} />

          <div className="mt-8">
            {windowClosed ? (
              <p className="text-[15px] text-slate-500 dark:text-white/60">Claim window closed.</p>
            ) : !connected ? (
              <Action label="Connect Wallet" onClick={handleConnect} />
            ) : phase === "not-eligible" ? (
              <NotEligible />
            ) : phase === "eligible" || phase === "claiming" ? (
              <>
                <Amount value={allocation?.amount ?? PREVIEW_AMOUNT} />
                <Action
                  label="Claim"
                  busyLabel="Claiming"
                  busy={phase === "claiming"}
                  disabled={Boolean(claimHold)}
                  onClick={handleClaim}
                />
                {claimHold ? (
                  <p className="mt-4 text-[13px] text-slate-500 dark:text-white/50">{claimHold}</p>
                ) : null}
              </>
            ) : phase === "claimed" ? (
              <>
                <Amount value={allocation?.amount ?? PREVIEW_AMOUNT} />
                <p className="mb-5 text-[15px] font-semibold text-emerald-600 dark:text-emerald-400">
                  Claimed
                </p>
                {claimTx ? (
                  <a
                    href={explorerTxUrl(claimTx)}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[12px] text-slate-400 underline dark:text-white/40"
                  >
                    {short(claimTx)}
                  </a>
                ) : null}
              </>
            ) : (
              <>
                {shownAddress ? (
                  <p className="mb-5 font-mono text-[13px] text-slate-400 dark:text-white/45">
                    {short(shownAddress)}
                  </p>
                ) : null}
                <Action
                  label="Check Eligibility"
                  busyLabel="Checking"
                  busy={phase === "checking"}
                  disabled={Boolean(checkHold)}
                  onClick={handleCheck}
                />
                {checkHold ? (
                  <p className="mt-4 text-[13px] text-slate-400 dark:text-white/50">{checkHold}</p>
                ) : null}
              </>
            )}

            {error ? (
              <p className="mt-5 text-[13px] text-red-500 dark:text-red-400">{error}</p>
            ) : null}
          </div>
        </div>

        {/* Eligibility breakdown lives below the claim card: the payout is the headline, the
            numbers behind it are the explanation. */}
        {stats && showAnyStats ? <EligibilityBreakdown stats={stats} /> : null}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------------------------

/** Soft brand wash behind the card. Purely decorative. */
function Backdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute left-1/2 top-[14%] h-[340px] w-[340px] -translate-x-1/2 rounded-full bg-[#2775CA] opacity-[0.16] blur-[110px] dark:opacity-25" />
      <div className="absolute bottom-[6%] left-[12%] h-[260px] w-[260px] rounded-full bg-[#0052ff] opacity-[0.10] blur-[110px] dark:opacity-20" />
    </div>
  );
}

function Coin() {
  return (
    <div className="relative mx-auto h-[76px] w-[76px]">
      <div
        className="absolute inset-0 rounded-full blur-[18px]"
        style={{ background: "#2775CA", opacity: 0.4 }}
      />
      <Image
        src="/usdc.svg"
        alt="USDC"
        width={76}
        height={76}
        priority
        className="relative rounded-full"
      />
    </div>
  );
}

function Stepper({ current, failed }: { current: number; failed: boolean }) {
  return (
    <div className="mt-7 flex items-start justify-center">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const active = n === current;
        const isFailed = failed && active;
        return (
          <div key={label} className="flex items-start">
            <div className="flex w-[94px] flex-col items-center">
              <div
                className={[
                  "flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-semibold transition",
                  isFailed
                    ? "bg-red-500 text-white"
                    : done
                      ? "bg-[#0052ff] text-white"
                      : active
                        ? "bg-[#0052ff] text-white shadow-[0_0_0_4px_rgba(0,82,255,0.16)]"
                        : "bg-slate-200 text-slate-400 dark:bg-white/10 dark:text-white/40",
                ].join(" ")}
              >
                {done ? "✓" : n}
              </div>
              <span
                className={[
                  "mt-2 text-[11px] leading-tight",
                  isFailed
                    ? "text-red-500 dark:text-red-400"
                    : active || done
                      ? "font-medium text-slate-700 dark:text-white/85"
                      : "text-slate-400 dark:text-white/40",
                ].join(" ")}
              >
                {label}
              </span>
            </div>
            {n < STEPS.length ? (
              <div
                className={[
                  "mt-4 h-[2px] w-5 shrink-0 rounded-full",
                  done ? "bg-[#0052ff]" : "bg-slate-200 dark:bg-white/10",
                ].join(" ")}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Amount({ value }: { value: bigint }) {
  return (
    <div className="mb-5">
      <p className="text-[46px] font-bold leading-none tracking-tight text-slate-900 dark:text-white">
        {formatClaimAmount(value)}
      </p>
      <p className="mt-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400 dark:text-white/45">
        {CLAIM_TOKEN_SYMBOL}
      </p>
    </div>
  );
}

/**
 * Page header: DustSwap wordmark on the left, the connected identity on the right. The wallet
 * button doubles as connect and, once connected, opens the disconnect menu, so the whole flow is
 * reachable without leaving this page.
 */
function ClaimHeader({ address }: { address: string | null }) {
  const [pfp, setPfp] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setPfp(null);
      return;
    }
    let cancelled = false;
    void fetchProfileSettings(address)
      .then((res) => {
        if (!cancelled) setPfp(res?.profile?.pfpUrl ?? null);
      })
      .catch(() => {
        // A missing avatar is not worth surfacing; the initial stands in.
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const initial = address ? address.slice(2, 3).toUpperCase() : "";

  return (
    <div className="mb-5 flex items-center justify-between gap-3">
      <Link href="/profile" aria-label="DustSwap">
        <ThemeLongLogo
          alt="DustSwap"
          width={178}
          height={42}
          priority
          className="h-auto w-[124px] sm:w-[150px]"
        />
      </Link>

      <div className="flex items-center gap-2">
        {address ? (
          pfp ? (
            <Image
              src={pfp}
              alt=""
              width={32}
              height={32}
              unoptimized
              className="h-8 w-8 rounded-full border border-slate-200 object-cover dark:border-white/15"
            />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-[12px] font-semibold text-slate-600 dark:border-white/15 dark:bg-white/10 dark:text-white/70">
              {initial}
            </span>
          )
        ) : null}

        <WalletConnectButton showDisconnect connectLabel="Connect" />
      </div>
    </div>
  );
}

function EligibilityBreakdown({ stats }: { stats: ClaimStats }) {
  return (
    <div className="mt-4 rounded-[22px] border border-slate-200/80 bg-white/90 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.04]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:text-white/45">
        Why you qualified
      </p>

      <div className="mt-3">
        {stats.cm === 1 ? <CommunityBadge /> : null}
        <Row
          label="Your total sweep volume"
          value={"$" + formatUsdTotal(stats.sv)}
          hit={Number(stats.sv) >= CLAIM_CRITERIA.sweepUsd}
        />
        <Row
          label="Your total swap volume"
          value={"$" + formatUsdTotal(stats.wv)}
          hit={Number(stats.wv) >= CLAIM_CRITERIA.swapVolumeUsd}
        />
        <Row
          label="Your total Streak Save"
          value={String(stats.ss)}
          hit={stats.ss >= CLAIM_CRITERIA.streakSaves}
          last
        />
      </div>
    </div>
  );
}

function CommunityBadge() {
  return (
    <div className="mb-1 flex items-center gap-2 border-b border-slate-200/70 pb-3 pt-1 dark:border-white/[0.07]">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#0052ff] text-[11px] font-bold text-white">
        {"✓"}
      </span>
      <span className="text-[13px] font-semibold text-slate-900 dark:text-white">
        Active community member
      </span>
    </div>
  );
}

function Row({
  label,
  value,
  hit,
  last,
}: {
  label: string;
  value: string;
  hit?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={[
        "flex items-center justify-between py-2.5 text-[13px]",
        last ? "" : "border-b border-slate-200/70 dark:border-white/[0.07]",
      ].join(" ")}
    >
      <span className="flex items-center gap-2 text-slate-500 dark:text-white/55">
        {hit ? (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[9px] font-bold text-white">
            {"✓"}
          </span>
        ) : (
          <span className="h-4 w-4 rounded-full border border-slate-300 dark:border-white/20" />
        )}
        {label}
      </span>
      <span className="font-semibold tabular-nums text-slate-900 dark:text-white">{value}</span>
    </div>
  );
}

function NotEligible() {
  return (
    <div>
      <p className="text-[15px] font-medium text-slate-900 dark:text-white">
        Sorry, you are not eligible for the airdrop.
      </p>

      <div className="mt-6 rounded-2xl border border-red-200 bg-red-50/70 px-4 py-4 text-left dark:border-red-500/25 dark:bg-red-500/[0.08]">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-red-500 dark:text-red-400">
          Minimum eligibility criteria
        </p>
        <ul className="mt-3 space-y-2">
          <Criterion>At least ${CLAIM_CRITERIA.sweepUsd} total sweep volume</Criterion>
          <Criterion>At least ${CLAIM_CRITERIA.swapVolumeUsd} total swap volume</Criterion>
          <Criterion>At least {CLAIM_CRITERIA.streakSaves} Streak Save</Criterion>
        </ul>
      </div>
    </div>
  );
}

function Criterion({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-[13.5px] text-red-600 dark:text-red-300">
      <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-red-500 dark:bg-red-400" />
      <span>{children}</span>
    </li>
  );
}

function Action({
  label,
  busyLabel,
  busy = false,
  disabled = false,
  onClick,
}: {
  label: string;
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="w-full rounded-xl bg-[#0052ff] py-3.5 text-[15px] font-semibold text-white shadow-[0_8px_22px_rgba(0,82,255,0.30)] transition hover:bg-[#0047e0] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
    >
      {busy ? (busyLabel ?? label) : label}
    </button>
  );
}

function PreviewPills({
  scenario,
  onChange,
}: {
  scenario: PreviewScenario;
  onChange: (next: PreviewScenario) => void;
}) {
  return (
    <div className="relative z-50 mb-4 flex w-full max-w-[400px] flex-wrap justify-center gap-1.5">
      {PREVIEW_SCENARIOS.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => {
            onChange(option.id);
            const url = new URL(window.location.href);
            url.searchParams.set("scenario", option.id);
            window.history.replaceState(null, "", url.toString());
          }}
          className={[
            "rounded-full px-2.5 py-1 text-[10px] font-medium transition",
            option.id === scenario
              ? "bg-[#0052ff] text-white"
              : "bg-slate-200/80 text-slate-600 dark:bg-white/10 dark:text-white/60",
          ].join(" ")}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

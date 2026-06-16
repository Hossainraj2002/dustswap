"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useSendTransaction } from "wagmi";
import { useWalletConnection } from "@/hooks/useWalletConnection";
import { WALLET_LINKING_ENABLED } from "@/lib/dustsweep-feature-flags";
import {
  buildLinkPaymentTx,
  confirmWalletLink,
  fetchWalletLinkRequest,
  WALLET_LINK_PAYMENT_ETH,
  type LinkRequestPreview,
} from "@/lib/walletLinkAuth";

type PageState =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "invalid"; message: string }
  | { kind: "ready" }
  | { kind: "linking" }
  | {
      kind: "success";
      awardedPp: number;
      newTotalPp: number;
      alreadyLinked: boolean;
    };

const BASE_ONLY_WALLET_LIST = ["base_account", "coinbase_wallet"] as const;

// Base App can reload the mini-app frame after a wallet tx, destroying the JS
// context before the confirm POST fires. Persist the attempt so we can resume
// (and complete the link) on the next load — even without the wallet connected.
type PendingLink = { address: string; txHash?: string };
function pendingKey(token: string) {
  return `dustswap:wl-pending:${token}`;
}
function readPending(token: string): PendingLink | null {
  try {
    const raw = window.localStorage.getItem(pendingKey(token));
    return raw ? (JSON.parse(raw) as PendingLink) : null;
  } catch {
    return null;
  }
}
function writePending(token: string, value: PendingLink) {
  try {
    window.localStorage.setItem(pendingKey(token), JSON.stringify(value));
  } catch {
    // ignore
  }
}
function clearPending(token: string) {
  try {
    window.localStorage.removeItem(pendingKey(token));
  } catch {
    // ignore
  }
}

function formatPp(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

function initialState(token: string | null): PageState {
  if (!WALLET_LINKING_ENABLED) {
    return { kind: "disabled" };
  }
  if (!token) {
    return { kind: "invalid", message: "This link is missing its token." };
  }
  return { kind: "loading" };
}

export function WalletLinkConfirm({ token }: { token: string | null }) {
  const [state, setState] = useState<PageState>(() => initialState(token));
  const [preview, setPreview] = useState<LinkRequestPreview | null>(null);
  const [bonusPp, setBonusPp] = useState(0);
  const [paymentTo, setPaymentTo] = useState<string | null>(null);
  const [paymentEth, setPaymentEth] = useState(WALLET_LINK_PAYMENT_ETH);
  const [hasPending, setHasPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { supportsBaseAccountFeatures, openWalletModal, disconnectWallet } =
    useWalletConnection();
  const { address: connectedAddress } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();

  const finishSuccess = useCallback(
    (result: {
      awardedPp: number;
      newTotalPp: number;
      alreadyLinked: boolean;
    }) => {
      if (token) clearPending(token);
      setHasPending(false);
      setState({
        kind: "success",
        awardedPp: result.awardedPp,
        newTotalPp: result.newTotalPp,
        alreadyLinked: result.alreadyLinked,
      });
    },
    [token]
  );

  // On mount: resume a pending confirm (survives a Base App frame reload), else
  // load the link preview.
  useEffect(() => {
    if (!WALLET_LINKING_ENABLED || !token) {
      return;
    }
    let cancelled = false;

    (async () => {
      const pending = readPending(token);
      if (pending?.address) {
        setHasPending(true);
        setState({ kind: "linking" });
        try {
          const result = await confirmWalletLink({
            token,
            address: pending.address,
            txHash: pending.txHash,
          });
          if (!cancelled) finishSuccess(result);
          return;
        } catch (err) {
          // Keep the pending marker so the user can retry without re-paying.
          if (!cancelled) {
            setError(
              err instanceof Error
                ? err.message
                : "Couldn't finish linking — tap Finish linking to retry."
            );
          }
        }
      }

      try {
        const result = await fetchWalletLinkRequest(token);
        if (cancelled) return;
        setPreview(result.preview);
        setBonusPp(result.bonusPp);
        setPaymentTo(result.paymentTo);
        setPaymentEth(result.paymentEth);
        setState({ kind: "ready" });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "invalid",
          message:
            err instanceof Error ? err.message : "This link is invalid or expired.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, finishSuccess]);

  const isBaseAccountConnected = Boolean(connectedAddress) && supportsBaseAccountFeatures;

  const handleConnect = useCallback(() => {
    setError(null);
    void openWalletModal(
      "Connect your Base Account to link it to your DustSwap profile",
      [...BASE_ONLY_WALLET_LIST]
    );
  }, [openWalletModal]);

  const handleConfirm = useCallback(async () => {
    if (!token || !connectedAddress) {
      return;
    }
    if (!supportsBaseAccountFeatures) {
      setError("Please connect a Base Account / Base App wallet to link.");
      return;
    }
    setError(null);
    setState({ kind: "linking" });
    try {
      // Persist the attempt BEFORE sending, so a frame reload during the tx can
      // still resume (the backend finds the payment from { token, address }).
      writePending(token, { address: connectedAddress });
      setHasPending(true);

      const tx = buildLinkPaymentTx(token, {
        to: paymentTo ?? undefined,
        eth: paymentEth,
      });
      const txHash = await sendTransactionAsync({
        to: tx.to,
        value: tx.value,
        data: tx.data,
      });
      writePending(token, { address: connectedAddress, txHash });

      const result = await confirmWalletLink({
        token,
        address: connectedAddress,
        txHash,
      });
      finishSuccess(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link your wallet.");
      setState({ kind: "ready" });
    }
  }, [
    token,
    connectedAddress,
    supportsBaseAccountFeatures,
    sendTransactionAsync,
    paymentTo,
    paymentEth,
    finishSuccess,
  ]);

  // Retry the confirm using the persisted attempt (already paid → no new tx).
  const handleResume = useCallback(async () => {
    if (!token) return;
    const pending = readPending(token);
    const address = pending?.address || connectedAddress;
    if (!address) {
      setError("Reconnect your Base Account to finish linking.");
      return;
    }
    setError(null);
    setState({ kind: "linking" });
    try {
      const result = await confirmWalletLink({
        token,
        address,
        txHash: pending?.txHash,
      });
      finishSuccess(result);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Still confirming your payment — please try again in a moment."
      );
      setState({ kind: "ready" });
    }
  }, [token, connectedAddress, finishSuccess]);

  const handleStartOver = useCallback(() => {
    if (token) clearPending(token);
    setHasPending(false);
    setError(null);
  }, [token]);

  const headerCopy = useMemo(
    () =>
      "Link your Base Account to your Dustswap profile. Use any wallet to check in, get spin tickets in both wallets, earn PP from onchain activity on both, and keep quests/socials together. You can unlink later.",
    []
  );

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-6 py-10">
      <meta name="referrer" content="no-referrer" />
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-bold text-slate-900">Link your Base Account</h1>

        {state.kind === "loading" && (
          <p className="mt-3 text-sm text-slate-500">Loading link…</p>
        )}

        {state.kind === "disabled" && (
          <p className="mt-3 text-sm text-slate-500">
            Wallet linking is not available right now.
          </p>
        )}

        {state.kind === "linking" && (
          <p className="mt-3 text-sm text-slate-500">Finishing your link…</p>
        )}

        {state.kind === "invalid" && (
          <div className="mt-3">
            <p className="text-sm text-red-600">{state.message}</p>
            <p className="mt-2 text-xs text-slate-500">
              Ask for a fresh link from your DustSwap profile and open it again
              inside Base App within 30 minutes.
            </p>
          </div>
        )}

        {state.kind === "ready" && (
          <>
            {preview && (
              <div className="mt-4 flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3">
                {preview.pfpUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={preview.pfpUrl}
                    alt=""
                    className="h-10 w-10 rounded-full object-cover"
                  />
                ) : (
                  <div className="h-10 w-10 rounded-full bg-slate-200" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">
                    {preview.displayName ||
                      (preview.username ? `@${preview.username}` : preview.shortAddress)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatPp(preview.totalPoints)} PP · {preview.currentStreak}d streak ·{" "}
                    {preview.shortAddress}
                  </p>
                </div>
              </div>
            )}

            <p className="mt-4 text-sm leading-relaxed text-slate-600">{headerCopy}</p>

            {bonusPp > 0 && (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-center">
                <p className="text-sm font-semibold text-emerald-700">
                  Earn {formatPp(bonusPp)} PP for linking
                </p>
                <p className="text-xs text-emerald-600">One-time reward · added to your profile</p>
              </div>
            )}

            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

            <div className="mt-5 space-y-2">
              {hasPending ? (
                <>
                  <button
                    type="button"
                    onClick={handleResume}
                    className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-700"
                  >
                    Finish linking
                  </button>
                  <p className="text-center text-[11px] text-slate-400">
                    You already paid — this finishes linking without another
                    transaction.
                  </p>
                  <button
                    type="button"
                    onClick={handleStartOver}
                    className="w-full rounded-xl border border-slate-200 px-4 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50"
                  >
                    Start over
                  </button>
                </>
              ) : !isBaseAccountConnected ? (
                <button
                  type="button"
                  onClick={handleConnect}
                  className="w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700"
                >
                  Connect Base Account
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleConfirm}
                    className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-700"
                  >
                    {`Confirm link · ${paymentEth} ETH`}
                  </button>
                  <p className="text-center text-[11px] text-slate-400">
                    Confirms with a {paymentEth} ETH transaction from this wallet to
                    verify ownership.
                  </p>
                  <button
                    type="button"
                    onClick={() => void disconnectWallet()}
                    className="w-full rounded-xl border border-slate-200 px-4 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50"
                  >
                    Use a different wallet
                  </button>
                </>
              )}
            </div>

            {!hasPending && Boolean(connectedAddress) && !supportsBaseAccountFeatures && (
              <p className="mt-3 text-xs text-amber-600">
                The connected wallet isn’t a Base Account. Open this link inside Base
                App and connect your Base Account to continue.
              </p>
            )}
          </>
        )}

        {state.kind === "success" && (
          <div className="mt-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl">
              ✓
            </div>
            <p className="mt-3 text-base font-semibold text-slate-900">
              {state.alreadyLinked ? "Wallet already linked" : "Wallets linked!"}
            </p>
            {state.awardedPp > 0 && (
              <p className="mt-1 text-sm font-semibold text-emerald-600">
                +{formatPp(state.awardedPp)} PP added to your profile
              </p>
            )}
            {state.newTotalPp > 0 && (
              <p className="mt-1 text-xs text-slate-500">
                New balance: {formatPp(state.newTotalPp)} PP
              </p>
            )}
            <Link
              href="/"
              className="mt-5 inline-block w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Back to DustSwap
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}

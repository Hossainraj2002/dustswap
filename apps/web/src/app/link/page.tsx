"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useSignMessage } from "wagmi";
import {
  useWalletConnection,
} from "@/hooks/useWalletConnection";
import { WALLET_LINKING_ENABLED } from "@/lib/dustsweep-feature-flags";
import {
  buildWalletLinkMessage,
  confirmWalletLink,
  fetchWalletLinkRequest,
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

function formatPp(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

export default function WalletLinkPage() {
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [preview, setPreview] = useState<LinkRequestPreview | null>(null);
  const [bonusPp, setBonusPp] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const { activeWallet, supportsBaseAccountFeatures, openWalletModal, disconnectWallet } =
    useWalletConnection();
  const { address: connectedAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();

  // Read the one-time token from the URL (avoids the useSearchParams Suspense
  // requirement, matching the Discord OAuth completion page pattern).
  useEffect(() => {
    if (!WALLET_LINKING_ENABLED) {
      setState({ kind: "disabled" });
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    if (!urlToken) {
      setState({ kind: "invalid", message: "This link is missing its token." });
      return;
    }
    setToken(urlToken);
  }, []);

  useEffect(() => {
    if (!token) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchWalletLinkRequest(token);
        if (cancelled) return;
        setPreview(result.preview);
        setBonusPp(result.bonusPp);
        setState({ kind: "ready" });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "invalid",
          message: err instanceof Error ? err.message : "This link is invalid or expired.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

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
      const message = buildWalletLinkMessage({
        address: connectedAddress,
        action: "confirm-link",
        token,
      });
      const signature = await signMessageAsync({ message });
      const result = await confirmWalletLink({
        token,
        address: connectedAddress,
        message,
        signature,
      });
      setState({
        kind: "success",
        awardedPp: result.awardedPp,
        newTotalPp: result.newTotalPp,
        alreadyLinked: result.alreadyLinked,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link your wallet.");
      setState({ kind: "ready" });
    }
  }, [token, connectedAddress, supportsBaseAccountFeatures, signMessageAsync]);

  const headerCopy = useMemo(
    () =>
      "Link your Base Account to your Dustswap profile. Use any wallet to check in, get spin tickets in both wallets, earn PP from onchain activity on both, and keep quests/socials together. You can unlink later.",
    []
  );

  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-slate-50 px-6 py-10"
      // Avoid leaking the one-time token via the Referer header.
      // (Set at the document level by the meta tag below as well.)
    >
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

        {state.kind === "invalid" && (
          <div className="mt-3">
            <p className="text-sm text-red-600">{state.message}</p>
            <p className="mt-2 text-xs text-slate-500">
              Ask for a fresh link from your DustSwap profile and open it again
              inside Base App within 30 minutes.
            </p>
          </div>
        )}

        {(state.kind === "ready" || state.kind === "linking") && (
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
              {!isBaseAccountConnected ? (
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
                    disabled={state.kind === "linking"}
                    className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                  >
                    {state.kind === "linking" ? "Linking…" : "Sign to confirm link"}
                  </button>
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

            {Boolean(connectedAddress) && !supportsBaseAccountFeatures && (
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

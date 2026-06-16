"use client";

import { useCallback, useEffect, useState } from "react";
import { useSignMessage } from "wagmi";
import { QRCodeSVG } from "qrcode.react";
import { WALLET_LINKING_ENABLED } from "@/lib/dustsweep-feature-flags";
import { isMobileDevice } from "@/lib/device";
import {
  buildBaseAppLink,
  buildWalletLinkMessage,
  createWalletLinkRequest,
  fetchLinkedWallets,
  unlinkWallet,
  type LinkedWallet,
} from "@/lib/walletLinkAuth";

type Props = {
  address?: string;
};

type CopyTarget = "direct" | "baseapp";

function shortAddr(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatCountdown(msLeft: number) {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function WalletLinkManager({ address }: Props) {
  const { signMessageAsync } = useSignMessage();
  const [wallets, setWallets] = useState<LinkedWallet[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [directLink, setDirectLink] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [bonusPp, setBonusPp] = useState(0);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isMobile, setIsMobile] = useState(false);

  // Compute device in an effect so SSR markup matches first client render.
  useEffect(() => {
    setIsMobile(isMobileDevice());
  }, []);

  const refreshWallets = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const result = await fetchLinkedWallets(address);
      setWallets(result.wallets);
    } catch {
      // non-fatal — leave list as-is
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void refreshWallets();
  }, [refreshWallets]);

  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  const linkExpired = Boolean(expiresAt && now >= expiresAt);
  const atWalletCap = wallets.length >= 2;
  const baseAppLink = token ? buildBaseAppLink(token) : null;
  const linkReady = Boolean(token && directLink) && !linkExpired;

  const handleCreateLink = useCallback(async () => {
    if (!address) return;
    setError(null);
    setBusy(true);
    try {
      const message = buildWalletLinkMessage({ address, action: "create-link-request" });
      const signature = await signMessageAsync({ message });
      const result = await createWalletLinkRequest({ address, message, signature });
      setToken(result.token);
      setDirectLink(result.url);
      setBonusPp(result.bonusPp);
      setExpiresAt(
        result.expiresAt ? new Date(result.expiresAt).getTime() : Date.now() + 30 * 60 * 1000
      );
      setNow(Date.now());
      setCopied(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a link.");
    } finally {
      setBusy(false);
    }
  }, [address, signMessageAsync]);

  const handleCopy = useCallback(async (text: string, which: CopyTarget) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
    } catch {
      setError("Couldn't copy — select and copy the link manually.");
    }
  }, []);

  const handleUnlink = useCallback(
    async (wallet: string) => {
      if (!address) return;
      setError(null);
      setBusy(true);
      try {
        const message = buildWalletLinkMessage({
          address,
          action: "unlink-wallet",
          wallet,
        });
        const signature = await signMessageAsync({ message });
        await unlinkWallet({ address, walletToUnlink: wallet, message, signature });
        await refreshWallets();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not unlink this wallet.");
      } finally {
        setBusy(false);
      }
    },
    [address, refreshWallets, signMessageAsync]
  );

  if (!WALLET_LINKING_ENABLED) {
    return null;
  }

  const connected = address ? address.toLowerCase() : null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-900">Linked wallets</h3>
      <p className="mt-1 text-xs text-slate-500">
        Link your Base Account so both wallets share one DustSwap profile. Earn a
        one-time bonus, get spin tickets in both wallets, and keep quests &amp;
        socials together.
      </p>

      <div className="mt-3 space-y-2">
        {wallets.map((wallet) => {
          const isConnected = connected === wallet.wallet_address.toLowerCase();
          return (
            <div
              key={wallet.wallet_address}
              className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">
                  {shortAddr(wallet.wallet_address)}
                  {wallet.is_primary && (
                    <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                      Primary
                    </span>
                  )}
                  {isConnected && !wallet.is_primary && (
                    <span className="ml-2 text-[10px] text-slate-400">connected</span>
                  )}
                </p>
              </div>
              {!wallet.is_primary && isConnected && (
                <button
                  type="button"
                  onClick={() => void handleUnlink(wallet.wallet_address)}
                  disabled={busy}
                  className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  Unlink
                </button>
              )}
              {!wallet.is_primary && !isConnected && (
                <span className="text-[10px] text-slate-400">connect to unlink</span>
              )}
            </div>
          );
        })}
        {!loading && wallets.length === 0 && (
          <p className="text-xs text-slate-400">No linked wallets yet.</p>
        )}
      </div>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      {!atWalletCap && (
        <div className="mt-4">
          {!linkReady ? (
            <button
              type="button"
              onClick={() => void handleCreateLink()}
              disabled={busy}
              className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {busy ? "Preparing…" : "Link a Base Account"}
            </button>
          ) : (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
              {bonusPp > 0 && (
                <p className="text-center text-xs font-semibold text-emerald-700">
                  Open in Base App to link and earn{" "}
                  {new Intl.NumberFormat("en-US").format(bonusPp)} PP.
                </p>
              )}

              {/* Base App deep link — mobile: open button; desktop: QR */}
              {isMobile ? (
                <a
                  href={baseAppLink ?? "#"}
                  rel="noreferrer"
                  className="mt-3 block w-full rounded-xl bg-[#0052ff] px-4 py-2.5 text-center text-sm font-semibold text-white hover:bg-[#0047db]"
                >
                  Open in Base App
                </a>
              ) : (
                <div className="mt-3 flex flex-col items-center">
                  <div className="rounded-xl bg-white p-3">
                    {baseAppLink && (
                      <QRCodeSVG value={baseAppLink} size={176} includeMargin={false} />
                    )}
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">
                    Scan with your phone to open in Base App
                  </p>
                </div>
              )}

              <button
                type="button"
                onClick={() => baseAppLink && void handleCopy(baseAppLink, "baseapp")}
                className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                {copied === "baseapp" ? "Copied Base App link" : "Copy Base App link"}
              </button>

              {/* Direct link — always available for manual/non-Base use */}
              <div className="mt-3 border-t border-emerald-200 pt-3">
                <p className="text-[11px] font-medium text-slate-500">Or copy the direct link</p>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    readOnly
                    value={directLink ?? ""}
                    className="min-w-0 flex-1 truncate rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
                  />
                  <button
                    type="button"
                    onClick={() => directLink && void handleCopy(directLink, "direct")}
                    className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
                  >
                    {copied === "direct" ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              {expiresAt && (
                <p className="mt-3 text-center text-[11px] text-slate-500">
                  Expires in {formatCountdown(expiresAt - now)}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {atWalletCap && (
        <p className="mt-3 text-xs text-slate-400">
          You&apos;ve linked the maximum of 2 wallets.
        </p>
      )}
    </section>
  );
}

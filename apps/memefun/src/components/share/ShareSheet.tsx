"use client";

import { useEffect, useState } from "react";
import { Check, Link2, Share } from "lucide-react";
import { formatUsd } from "@/core/format";
import { milestoneLabel } from "@/core/milestones";
import { useNow } from "@/lib/hooks";
import type { Coin } from "@/lib/market/types";
import { referralLink } from "@/lib/referrals";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { Sheet } from "@/components/ui/Sheet";
import { coinRing } from "@/components/coin/ring";
import { FarcasterLogo, TelegramLogo, XLogo } from "./BrandIcons";

export type ShareMoment = { kind: "coin" } | { kind: "launch" } | { kind: "milestone"; milestone: number };

export function shareText(coin: Coin, moment: ShareMoment): string {
  switch (moment.kind) {
    case "launch":
      return `I just launched $${coin.symbol} on memefun. Fixed supply, no admin keys, liquidity locked forever.`;
    case "milestone":
      return `$${coin.symbol} just passed ${milestoneLabel(moment.milestone)} market cap on memefun.`;
    case "coin":
      return `$${coin.symbol} is at ${formatUsd(coin.marketCapUsd, { compact: true })} market cap on memefun. No admin keys, liquidity locked forever.`;
  }
}

interface ShareSheetProps {
  coin: Coin;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  moment?: ShareMoment;
}

/** Every link carries the sharer's referral, so sharing pays. */
export function ShareSheet({ coin, open, onOpenChange, moment = { kind: "coin" } }: ShareSheetProps) {
  const wallet = useWallet();
  const now = useNow();
  const [copied, setCopied] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);
  const url = referralLink(`/t/${coin.address}`, wallet.address);
  const text = shareText(coin, moment);

  useEffect(() => setCanNativeShare(typeof navigator !== "undefined" && typeof navigator.share === "function"), []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const targets = [
    { label: "X", icon: <XLogo className="size-5" />, href: `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}` },
    { label: "Farcaster", icon: <FarcasterLogo className="size-5" />, href: `https://farcaster.xyz/~/compose?text=${encodeURIComponent(text)}&embeds[]=${encodeURIComponent(url)}` },
    { label: "Telegram", icon: <TelegramLogo className="size-5" />, href: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}` },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={moment.kind === "launch" ? "Share your coin" : `Share ${coin.symbol}`} description="Links you share include your referral. You earn part of the platform fee on trades they bring.">
      <div className="flex flex-col gap-5">
        <div className="mf-card flex items-center gap-4 bg-bg-elevated-2 p-4 shadow-none">
          <CoinAvatar src={coin.image} alt="" size={64} ring={coinRing(coin, now)} symbol={coin.symbol} />
          <div className="min-w-0">
            <p className="truncate text-headline text-label">{coin.name}</p>
            <p className="text-subhead text-label-2">${coin.symbol}</p>
            <p className="mf-num text-title3 text-label">{formatUsd(coin.marketCapUsd, { compact: true })}</p>
          </div>
        </div>
        <p className="rounded-md bg-fill-4 px-3 py-2 text-subhead text-label">{text}</p>
        <div className="grid grid-cols-4 gap-2">
          {targets.map((target) => (
            <a
              key={target.label}
              href={target.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col items-center gap-1.5 rounded-lg py-2 text-caption1 font-semibold text-label transition-colors hover:bg-fill-4"
            >
              <span className="flex size-12 items-center justify-center rounded-full bg-fill-3">{target.icon}</span>
              {target.label}
            </a>
          ))}
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(`${text} ${url}`);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
            className="flex flex-col items-center gap-1.5 rounded-lg py-2 text-caption1 font-semibold text-label transition-colors hover:bg-fill-4"
          >
            <span className="flex size-12 items-center justify-center rounded-full bg-fill-3">
              {copied ? <Check className="size-5 text-up" aria-hidden /> : <Link2 className="size-5" aria-hidden />}
            </span>
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
        {canNativeShare ? (
          <button
            type="button"
            onClick={() => void navigator.share({ title: coin.name, text, url }).catch(() => {})}
            className="flex h-11 items-center justify-center gap-2 rounded-sm bg-fill-3 text-headline text-tint transition-colors hover:bg-fill-2"
          >
            <Share className="size-5" aria-hidden />
            More options
          </button>
        ) : null}
        <p className="break-all text-center text-caption1 text-label-2">{url}</p>
      </div>
    </Sheet>
  );
}

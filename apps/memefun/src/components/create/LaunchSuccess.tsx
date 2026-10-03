"use client";

import Link from "next/link";
import { useState } from "react";
import { motion } from "motion/react";
import { Share } from "lucide-react";
import { formatUsd } from "@/core/format";
import { spring } from "@/lib/motion";
import type { Coin } from "@/lib/market/types";
import { usePreview } from "@/lib/preview/scenario";
import { Button } from "@/components/ui/Button";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { ShareSheet } from "@/components/share/ShareSheet";

export function LaunchSuccess({ coin, onLaunchAnother }: { coin: Coin; onLaunchAnother: () => void }) {
  const [sharing, setSharing] = useState(false);
  const { preview } = usePreview();
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 py-10 text-center">
      <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.gentle}>
        <CoinAvatar src={coin.image} alt={`${coin.name} logo`} size={144} ring={{ kind: "milestone", progress: 0.02 }} symbol={coin.symbol} />
      </motion.div>
      <div className="flex flex-col gap-2">
        <h1 className="text-large-title text-label">{coin.symbol} is live</h1>
        <p className="text-body text-label-2">
          {coin.name} is trading on Base at {formatUsd(coin.marketCapUsd, { compact: true })} market cap. Its liquidity is locked forever.
          {preview ? " This is a preview launch, nothing was created on chain." : ""}
        </p>
      </div>
      <div className="mf-card w-full p-4 text-left">
        <p className="text-headline text-label">Share it to get it moving</p>
        <p className="mt-1 text-subhead text-label-2">
          Your link carries your referral. On top of your creator fees, you earn part of the platform fee on every trade it brings in.
        </p>
      </div>
      <div className="flex w-full flex-col gap-3">
        <Button size="lg" fullWidth leading={<Share className="size-5" aria-hidden />} onClick={() => setSharing(true)}>
          Share {coin.symbol}
        </Button>
        <Button asChild size="lg" variant="gray" fullWidth>
          <Link href={`/t/${coin.address}`}>View coin</Link>
        </Button>
        <Button size="lg" variant="plain" fullWidth onClick={onLaunchAnother}>
          Launch another
        </Button>
      </div>
      <ShareSheet coin={coin} open={sharing} onOpenChange={setSharing} moment={{ kind: "launch" }} />
    </div>
  );
}

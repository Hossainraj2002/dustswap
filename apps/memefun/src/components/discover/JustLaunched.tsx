"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { formatAge, formatPercent } from "@/core/format";
import { launchFeeBps } from "@/core/antiSnipe";
import { useAnimationNow, useNow } from "@/lib/hooks";
import { spring } from "@/lib/motion";
import type { Coin } from "@/lib/market/types";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { UsdFlow } from "@/components/coin/CoinBits";
import { coinRing, inProtection } from "@/components/coin/ring";

/** The newest launches. Coins still inside launch protection show the live fee. */
export function JustLaunched({ coins }: { coins: Coin[] }) {
  const now = useNow();
  const anyProtected = coins.some((coin) => inProtection(coin, now));
  const smoothNow = useAnimationNow(anyProtected);
  const clock = anyProtected ? smoothNow : now;

  return (
    <section aria-labelledby="just-launched" className="mf-card flex flex-col p-4">
      <div className="flex items-baseline justify-between px-1 pb-2">
        <h2 id="just-launched" className="text-headline text-label">
          Just launched
        </h2>
        <Link href="/?sort=new" className="text-footnote font-semibold text-tint">
          See all
        </Link>
      </div>
      <ul className="flex flex-col">
        <AnimatePresence initial={false}>
          {coins.map((coin) => {
            const protecting = inProtection(coin, clock);
            const fee = launchFeeBps(coin.terms.feeBps, { startBps: coin.terms.snipeStartBps, durationSec: coin.terms.snipeDurationSec }, (clock - coin.createdAt) / 1000);
            return (
              <motion.li
                key={coin.address}
                layout
                initial={{ opacity: 0, y: -12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={spring.snappy}
              >
                <Link href={`/t/${coin.address}`} className="flex min-h-14 items-center gap-3 rounded-md px-1 py-2 transition-colors hover:bg-fill-4">
                  <CoinAvatar src={coin.image} alt="" size={44} ring={coinRing(coin, clock)} symbol={coin.symbol} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-subhead font-semibold text-label">{coin.name}</span>
                    <span className="text-footnote text-label-2">
                      ${coin.symbol} · {now > 0 ? formatAge(now - coin.createdAt) : ""}
                    </span>
                  </span>
                  {protecting ? (
                    <span className="mf-num text-right text-footnote font-semibold text-warning">
                      Fee {formatPercent(fee / 10_000)}
                    </span>
                  ) : (
                    <UsdFlow value={coin.marketCapUsd} className="text-subhead font-semibold text-label" />
                  )}
                </Link>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </section>
  );
}

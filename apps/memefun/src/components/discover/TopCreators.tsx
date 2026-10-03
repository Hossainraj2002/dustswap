"use client";

import Link from "next/link";
import { formatUsd } from "@/core/format";
import { useCreators } from "@/lib/market/hooks";
import { AddressAvatar } from "@/components/ui/AddressAvatar";
import { SectionHeader } from "@/components/ui/display";

/** Creators ranked by what their coins have paid them. */
export function TopCreators() {
  const creators = useCreators()
    .filter((creator) => creator.coins.length > 0)
    .sort((a, b) => b.earnedUsd - a.earnedUsd)
    .slice(0, 10);
  if (creators.length === 0) return null;
  return (
    <section aria-labelledby="top-creators" className="flex flex-col gap-3">
      <SectionHeader id="top-creators" title="Top creators" />
      <ol className="mf-scroll-x -mx-4 flex gap-3 px-4 pb-1 sm:-mx-5 sm:px-5 lg:mx-0 lg:px-0">
        {creators.map((creator, index) => (
          <li key={creator.address} className="shrink-0">
            <Link
              href={`/u/${creator.address}`}
              className="mf-card flex w-[168px] flex-col gap-3 p-4 transition-shadow hover:shadow-float"
            >
              <div className="flex items-center justify-between">
                <AddressAvatar address={creator.address} size={40} />
                <span className="mf-num text-footnote font-semibold text-label-2">#{index + 1}</span>
              </div>
              <div className="min-w-0">
                <p className="truncate text-subhead font-semibold text-label">{creator.name || "Creator"}</p>
                <p className="text-footnote text-label-2">
                  {creator.coins.length} {creator.coins.length === 1 ? "coin" : "coins"}
                </p>
              </div>
              <div>
                <p className="text-caption1 text-label-2">Earned</p>
                <p className="mf-num text-headline text-up">{formatUsd(creator.earnedUsd, { compact: true })}</p>
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

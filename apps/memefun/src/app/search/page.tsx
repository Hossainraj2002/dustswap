"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useCoins } from "@/lib/market/hooks";
import { PageHeader } from "@/components/shell/PageHeader";
import { matchCoins } from "@/components/shell/SearchCommand";
import { CoinRow } from "@/components/coin/CoinRow";
import { EmptyState, Skeleton } from "@/components/ui/display";

/** Full-screen search, the Search tab on phones. Desktop uses the Cmd+K palette. */
export default function SearchPage() {
  const { coins, ready } = useCoins();
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const results = matchCoins(coins, query, 30);

  return (
    <>
      <PageHeader title="Search" />
      <div className="sticky top-0 z-20 -mx-4 mb-4 bg-bg-grouped/90 px-4 py-2 backdrop-blur-xl sm:-mx-5 sm:px-5 lg:static lg:mx-0 lg:bg-transparent lg:px-0 lg:backdrop-blur-none">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-3 size-[18px] text-label-2" aria-hidden />
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, ticker or contract address"
            aria-label="Search coins"
            autoComplete="off"
            spellCheck={false}
            className="h-11 w-full rounded-[10px] bg-fill-3 pl-10 pr-10 text-body text-label outline-none placeholder:text-placeholder focus:shadow-[0_0_0_2px_var(--mf-tint)] [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                input.current?.focus();
              }}
              className="absolute right-2 flex size-7 items-center justify-center rounded-full bg-label-3 text-bg"
            >
              <X className="size-3.5" strokeWidth={3} aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
      <h2 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label-2">{query ? "Results" : "Trending"}</h2>
      {!ready ? (
        <Skeleton className="h-64 w-full rounded-lg" />
      ) : results.length === 0 ? (
        <div className="mf-card">
          <EmptyState icon={<Search aria-hidden />} title="No coins match" message="Try a ticker like TOAD, part of a name, or paste a contract address." />
        </div>
      ) : (
        <div className="mf-card overflow-hidden [&>*+*]:hairline-t" aria-live="polite">
          {results.map((coin) => (
            <CoinRow key={coin.address} coin={coin} />
          ))}
        </div>
      )}
    </>
  );
}

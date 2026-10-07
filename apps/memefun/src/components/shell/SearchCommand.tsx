"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { Dialog, VisuallyHidden } from "radix-ui";
import { CircleHelp, Gift, Plus, Search, UserRound } from "lucide-react";
import { formatUsd } from "@/core/format";
import { useCoins } from "@/lib/market/hooks";
import type { Coin } from "@/lib/market/types";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { ChangeText } from "@/components/ui/display";

export function useSearchShortcut(onOpen: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
}

/** Matches name, ticker (with or without $) or contract address. */
export function matchCoins(coins: Coin[], query: string, limit = 12): Coin[] {
  const q = query.trim().toLowerCase().replace(/^\$/, "");
  if (!q) return [...coins].sort((a, b) => b.momentum - a.momentum).slice(0, limit);
  return coins
    .map((coin) => {
      const symbol = coin.symbol.toLowerCase();
      const name = coin.name.toLowerCase();
      const address = coin.address.toLowerCase();
      const score =
        symbol === q ? 0 : symbol.startsWith(q) ? 1 : name.startsWith(q) ? 2 : name.includes(q) || symbol.includes(q) ? 3 : address.startsWith(q) ? 4 : 99;
      return { coin, score };
    })
    .filter((entry) => entry.score < 99)
    .sort((a, b) => a.score - b.score || b.coin.marketCapUsd - a.coin.marketCapUsd)
    .slice(0, limit)
    .map((entry) => entry.coin);
}

export function SearchCommand({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const { coins, ready } = useCoins();

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-32px)] max-w-[600px] -translate-x-1/2 overflow-hidden rounded-xl bg-bg-elevated shadow-float outline-none mf-squircle">
          <VisuallyHidden.Root>
            <Dialog.Title>Search</Dialog.Title>
            <Dialog.Description>Find a coin by name, ticker or contract address.</Dialog.Description>
          </VisuallyHidden.Root>
          <Command label="Search coins" loop shouldFilter={false}>
            <CommandSearch coins={coins} ready={ready} go={go} />
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CommandSearch({ coins, ready, go }: { coins: Coin[]; ready: boolean; go: (href: string) => void }) {
  const [query, setQuery] = useState("");
  const results = matchCoins(coins, query, 8);
  const itemClass =
    "flex min-h-12 cursor-pointer items-center gap-3 rounded-md px-3 text-body text-label data-[selected=true]:bg-fill-3";
  return (
    <>
      <div className="hairline-b flex items-center gap-3 px-4">
        <Search className="size-5 text-label-2" aria-hidden />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Search name, ticker or address"
          className="h-14 flex-1 bg-transparent text-body text-label outline-none placeholder:text-label-2"
        />
      </div>
      <Command.List className="max-h-[56vh] overflow-y-auto p-2">
        {!ready ? <p role="status" className="px-3 py-8 text-center text-subhead text-label-2">Loading coins…</p>
          : <Command.Empty className="px-3 py-8 text-center text-subhead text-label-2">No coins match. Try a ticker or a contract address.</Command.Empty>}
        {results.length > 0 ? (
          <Command.Group heading={query ? "Coins" : "Trending"} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-footnote [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-label-2">
            {results.map((coin) => (
              <Command.Item key={coin.address} value={coin.address} onSelect={() => go(`/t/${coin.address}`)} className={itemClass}>
                <CoinAvatar src={coin.image} alt="" size={36} symbol={coin.symbol} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold">{coin.name}</span>
                  <span className="text-footnote text-label-2">${coin.symbol}</span>
                </span>
                <span className="flex flex-col items-end">
                  <span className="mf-num text-subhead">{formatUsd(coin.marketCapUsd, { compact: true })}</span>
                  <ChangeText value={coin.change24h} className="text-footnote" />
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {!query ? (
          <Command.Group heading="Go to" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-footnote [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-label-2">
            <Command.Item value="create" onSelect={() => go("/create")} className={itemClass}>
              <Plus className="size-5 text-tint" aria-hidden /> Create a coin
            </Command.Item>
            <Command.Item value="rewards" onSelect={() => go("/rewards")} className={itemClass}>
              <Gift className="size-5 text-tint" aria-hidden /> Rewards
            </Command.Item>
            <Command.Item value="profile" onSelect={() => go("/me")} className={itemClass}>
              <UserRound className="size-5 text-tint" aria-hidden /> Profile
            </Command.Item>
            <Command.Item value="how" onSelect={() => go("/how-it-works")} className={itemClass}>
              <CircleHelp className="size-5 text-tint" aria-hidden /> How it works
            </Command.Item>
          </Command.Group>
        ) : null}
      </Command.List>
    </>
  );
}

"use client";

import { useMemo } from "react";
import type { Address, Hash } from "@/core/types";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { useMarket } from "./MarketProvider";
import type { CandleInterval } from "./types";
import type { PairCatalogSort } from "./pairs";

/* Each hook re-reads when the market version changes. `ready` is false until
 * the client-side market exists, which is when screens show skeletons. */

export function useCoins() {
  const { market, version } = useMarket();
  return useMemo(() => ({ ready: Boolean(market), coins: market?.listCoins() ?? [] }), [market, version]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useCoin(address: string | undefined) {
  const { market, version } = useMarket();
  return useMemo(
    () => ({ ready: Boolean(market), coin: address ? market?.getCoin(address) : undefined }),
    [market, version, address], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

export function useTrades(address: string | undefined, limit = 60, poolId?: Hash) {
  const { market, version } = useMarket();
  return useMemo(() => (address && market ? market.getTrades(address, limit, poolId) : []), [market, version, address, limit, poolId]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useHolders(address: string | undefined, limit = 25) {
  const { market, version } = useMarket();
  const { address: viewer } = useWallet();
  return useMemo(
    () => (address && market ? market.getHolders(address, viewer ?? undefined, limit) : []),
    [market, version, address, viewer, limit], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

export function useComments(address: string | undefined) {
  const { market, version } = useMarket();
  return useMemo(() => (address && market ? market.getComments(address) : []), [market, version, address]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useCandles(address: string | undefined, interval: CandleInterval, metric: "price" | "mcap", poolId?: Hash) {
  const { market, version } = useMarket();
  return useMemo(
    () => (address && market ? market.getCandles(address, interval, metric, poolId) : []),
    [market, version, address, interval, metric, poolId], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

export function useActivity(limit = 40) {
  const { market, version } = useMarket();
  return useMemo(() => market?.getActivity(limit) ?? [], [market, version, limit]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useCreators() {
  const { market, version } = useMarket();
  return useMemo(() => market?.getCreators() ?? [], [market, version]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useCreatorProfile(address: string | undefined) {
  const { market, version } = useMarket();
  return useMemo(() => (address && market ? market.creatorProfile(address) : undefined), [market, version, address]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useTradesByTrader(trader: string | null | undefined, limit = 50) {
  const { market, version } = useMarket();
  return useMemo(() => (trader && market ? market.getTradesByTrader(trader, limit) : []), [market, version, trader, limit]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useModeration() {
  const { market, version } = useMarket();
  return useMemo(() => market?.getModeration() ?? { hidden: [], featured: [], banner: "" }, [market, version]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useLaunchSettings() {
  const { market, version } = useMarket();
  return useMemo(() => {
    const settings = market?.getSettings();
    return market?.isSettingsReady() ? settings : undefined;
  }, [market, version]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function usePositions(owner: Address | null | undefined) {
  const { market, version } = useMarket();
  return useMemo(() => (owner && market ? market.getPositions(owner) : []), [market, version, owner]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useClaimables(owner: Address | null | undefined) {
  const { market, version } = useMarket();
  return useMemo(() => (owner && market ? market.getClaimables(owner) : []), [market, version, owner]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useQuoteBalance(owner: Address | null | undefined, pairId: string | undefined) {
  const { market, version } = useMarket();
  return useMemo(() => (owner && pairId && market ? market.getQuoteBalance(owner, pairId) : 0), [market, version, owner, pairId]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useCoinBalance(owner: Address | null | undefined, coin: string | undefined) {
  const { market, version } = useMarket();
  return useMemo(() => (owner && coin && market ? market.getCoinBalance(owner, coin) : 0), [market, version, owner, coin]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Pair assets a coin can launch with (live: from the API; preview: the simulated list). */
export function useQuoteAssets() {
  const { market, version } = useMarket();
  return useMemo(() => market?.listQuotes() ?? [], [market, version]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function usePairCatalog(sort: PairCatalogSort = "trending") {
  const { market, version } = useMarket();
  return useMemo(() => ({ quotes: market?.listPairCatalog?.(sort) ?? market?.listQuotes() ?? [],
    notice: market?.getPairCatalogNotice?.(sort) }), [market, version, sort]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Whether the data on screen is current; live mode reports outages here. */
export function useMarketStatus() {
  const { market, version } = useMarket();
  return useMemo(() => market?.getStatus() ?? { state: "loading" as const }, [market, version]); // eslint-disable-line react-hooks/exhaustive-deps
}

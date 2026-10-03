"use client";

import { useMemo } from "react";
import type { Address } from "@/core/types";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { useMarket } from "./MarketProvider";
import type { CandleInterval } from "./types";

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

export function useTrades(address: string | undefined, limit = 60) {
  const { market, version } = useMarket();
  return useMemo(() => (address && market ? market.getTrades(address, limit) : []), [market, version, address, limit]); // eslint-disable-line react-hooks/exhaustive-deps
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

export function useCandles(address: string | undefined, interval: CandleInterval, metric: "price" | "mcap") {
  const { market, version } = useMarket();
  return useMemo(
    () => (address && market ? market.getCandles(address, interval, metric) : []),
    [market, version, address, interval, metric], // eslint-disable-line react-hooks/exhaustive-deps
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
  return useMemo(() => market?.getSettings(), [market, version]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function usePositions(owner: Address | null | undefined) {
  const { market, version } = useMarket();
  return useMemo(() => (owner && market ? market.getPositions(owner) : []), [market, version, owner]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useClaimables(owner: Address | null | undefined) {
  const { market, version } = useMarket();
  return useMemo(() => (owner && market ? market.getClaimables(owner) : []), [market, version, owner]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useQuoteBalance(owner: Address | null | undefined, symbol: string | undefined) {
  const { market, version } = useMarket();
  return useMemo(() => (owner && symbol && market ? market.getQuoteBalance(owner, symbol) : 0), [market, version, owner, symbol]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useCoinBalance(owner: Address | null | undefined, coin: string | undefined) {
  const { market, version } = useMarket();
  return useMemo(() => (owner && coin && market ? market.getCoinBalance(owner, coin) : 0), [market, version, owner, coin]); // eslint-disable-line react-hooks/exhaustive-deps
}

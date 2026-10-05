import { COIN_SUPPLY } from "@/core/constants";
import type { Hash } from "@/core/types";
import type { Coin, CoinMarket, Trade } from "./types";

export const MAX_MARKETS = 5;

/** Integer allocations conserve the fixed supply, including the last wei for three pools. */
export function equalAllocations(count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_MARKETS) throw new RangeError("Choose between one and five pools.");
  const each = COIN_SUPPLY / BigInt(count);
  return Array.from({ length: count }, (_, i) => i === count - 1 ? COIN_SUPPLY - each * BigInt(count - 1) : each);
}

export function coinMarkets(coin: Coin): CoinMarket[] {
  return coin.markets ?? [];
}

/** A pool view uses that pool's quote amounts. Token balances and supply stay global. */
export function selectCoinMarket(coin: Coin, poolId?: Hash): Coin {
  if (!poolId) return coin;
  const market = coin.markets?.find((entry) => entry.poolId.toLowerCase() === poolId.toLowerCase());
  if (!market) throw new Error("That pool does not belong to this token.");
  const supply = coin.priceUsd > 0 ? coin.marketCapUsd / coin.priceUsd : 1_000_000_000;
  return { ...coin, ...market, marketCapUsd: market.priceUsd * supply, fdvUsd: market.priceUsd * 1_000_000_000, selectedPoolId: market.poolId };
}

/** Quote units must never be summed across currencies. Discovery aggregates USD only. */
export function aggregateCoinMarkets(coin: Coin): Coin {
  if (!coin.markets?.length) return coin;
  const poolWeight = (market: CoinMarket) => market.poolCoins ?? Number(market.supplyRaw) / 1e18;
  const weight = coin.markets.reduce((sum, market) => sum + poolWeight(market), 0);
  const priceUsd = weight > 0 ? coin.markets.reduce((sum, market) => sum + market.priceUsd * poolWeight(market) / weight, 0) : coin.markets[0]!.priceUsd;
  const supply = coin.priceUsd > 0 ? coin.marketCapUsd / coin.priceUsd : 1_000_000_000;
  return { ...coin, priceUsd, fdvUsd: priceUsd * 1_000_000_000, marketCapUsd: priceUsd * supply,
    liquidityUsd: coin.markets.reduce((sum, market) => sum + market.liquidityUsd, 0),
    volume24hUsd: coin.markets.reduce((sum, market) => sum + market.volume24hUsd, 0),
    volumeTotalUsd: coin.markets.reduce((sum, market) => sum + market.volumeTotalUsd, 0) };
}

export function tradeQuoteSymbol(coin: Coin, trade: Pick<Trade, "poolId" | "quote">): string {
  return coin.markets?.find((market) => market.poolId === trade.poolId || (trade.quote && market.quote.address.toLowerCase() === trade.quote.toLowerCase()))?.quote.symbol ?? coin.quote.symbol;
}

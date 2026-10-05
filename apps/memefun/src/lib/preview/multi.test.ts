import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COIN_SUPPLY, COIN_SUPPLY_HUMAN } from "@/core/constants";
import { ETH, QUOTES, USDC } from "@/lib/market/quotes";
import type { LaunchInput } from "@/lib/market/Market";
import { PreviewMarket } from "./engine";

const USER = "0x00000000000000000000000000000000000000aa" as const;
const NEXT = "0x00000000000000000000000000000000000000bb" as const;
const PAYOUT = "0x00000000000000000000000000000000000000cc" as const;
const NOW = Date.UTC(2026, 9, 4, 12);
const input: LaunchInput = { name: "One Token", symbol: "ONE", image: "", description: "", links: {}, quote: ETH,
  mode: "creator", feeBps: 100, creatorKeepBps: 0, firstBuyQuote: 0,
  markets: [{ quote: ETH, firstBuyQuote: 0 }, { quote: USDC, firstBuyQuote: 25, firstBuyText: "25" }] };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });
async function finish<T>(promise: Promise<T>): Promise<T> { await vi.runAllTimersAsync(); return promise; }

describe("one token across independent preview markets", () => {
  it("uses one address, equal allocations, same opening price and a first buy only in the chosen pool", async () => {
    const market = new PreviewMarket({ now: NOW, empty: true });
    const coin = await finish(market.launch(USER, input));
    expect(market.listCoins()).toHaveLength(1);
    expect(coin.markets).toHaveLength(2);
    expect(coin.markets!.reduce((sum, entry) => sum + BigInt(entry.supplyRaw), 0n)).toBe(COIN_SUPPLY);
    expect(market.getTrades(coin.address, 100, coin.markets![0]!.poolId)).toHaveLength(0);
    expect(market.getTrades(coin.address, 100, coin.markets![1]!.poolId)).toHaveLength(1);
    expect(market.getCoinBalance(USER, coin.address)).toBeGreaterThan(0);
    const holders = market.getHolders(coin.address, USER, 100);
    expect(holders.reduce((sum, holder) => sum + holder.balance, 0)).toBeCloseTo(COIN_SUPPLY_HUMAN, 5);
    expect(coin.markets![0]!.priceUsd).toBeCloseTo(5000 / COIN_SUPPLY_HUMAN, 12);
    expect(coin.markets![1]!.stats.creatorEarnedQuote).toBeCloseTo(0.2, 12);
    expect(coin.markets![0]!.stats.creatorEarnedQuote).toBe(0);
    await finish(market.trade(USER, coin.address, "sell", 1, 0, { poolId: coin.markets![1]!.poolId }));
    expect(market.getCoin(coin.address)!.devSold).toBe(true);
  });
  it("buys through another pool into the same balance and pays rewards in each currency", async () => {
    const market = new PreviewMarket({ now: NOW, empty: true });
    const coin = await finish(market.launch(USER, input));
    const eth = coin.markets![0]!.poolId;
    const usdc = coin.markets![1]!.poolId;
    const before = market.getCoinBalance(USER, coin.address);
    const trade = await finish(market.trade(USER, coin.address, "buy", 0.01, 0, { poolId: eth }));
    expect(trade.poolId).toBe(eth);
    expect(trade.quote).toBe(ETH.address);
    expect(market.getCoinBalance(USER, coin.address)).toBeCloseTo(before + trade.coinAmount, 5);
    expect(market.getTrades(coin.address, 100, usdc)).toHaveLength(1);
    const claimables = market.getClaimables(USER);
    expect(claimables.map((item) => item.quoteSymbol).sort()).toEqual(["ETH", "USDC"]);
    const payoutBefore = market.ensureUser(PAYOUT).balances.get("USDC")!;
    await finish(market.claim(USER, claimables.filter((item) => item.quoteSymbol === "USDC"), "ok", undefined, PAYOUT));
    expect(market.getQuoteBalance(PAYOUT, "USDC")).toBeCloseTo(payoutBefore + 0.2, 10);
    expect(market.getClaimables(USER).map((item) => item.quoteSymbol)).toEqual(["ETH"]);
  });
  it("lowers every market fee permanently and transfers pending earnings only after recipient acceptance", async () => {
    const market = new PreviewMarket({ now: NOW, empty: true });
    const coin = await finish(market.launch(USER, input));
    await expect(market.lowerFee(NEXT, coin.address, 50)).rejects.toThrow("current creator");
    await market.lowerFee(USER, coin.address, 50);
    await expect(market.lowerFee(USER, coin.address, 100)).rejects.toThrow("lower");
    const changed = market.getCoin(coin.address)!;
    for (const pool of changed.markets!) expect(market.quote(coin.address, "buy", 1, NOW + 60_000, false, pool.poolId).feeBps).toBe(50);
    expect(changed.terms.mode).toBe("creator");
    await market.proposeCreator(USER, coin.address, NEXT);
    expect(market.getCoin(coin.address)!.creator).toBe(USER);
    await expect(market.acceptCreator(PAYOUT, coin.address)).rejects.toThrow("proposed");
    await market.acceptCreator(NEXT, coin.address);
    expect(market.getCoin(coin.address)!.creator).toBe(NEXT);
    expect(market.getClaimables(USER)).toEqual([]);
    expect(market.getClaimables(NEXT).some((item) => item.quoteSymbol === "USDC" && item.amountQuote === 0.2)).toBe(true);
  });
  it("rejects duplicate pairs and supports five pools without multiplying supply or opening FDV", async () => {
    const market = new PreviewMarket({ now: NOW, empty: true });
    await expect(market.launch(USER, { ...input, markets: [input.markets![0]!, input.markets![0]!] })).rejects.toThrow("different");
    const coin = await finish(market.launch(USER, { ...input, markets: QUOTES.slice(0, 5).map((quote) => ({ quote, firstBuyQuote: 0 })) }));
    expect(coin.markets).toHaveLength(5);
    expect(coin.fdvUsd).toBeCloseTo(5000, 8);
    expect(coin.liquidityUsd).toBeCloseTo(5000, 8);
    expect(coin.markets!.reduce((sum, pool) => sum + BigInt(pool.supplyRaw), 0n)).toBe(COIN_SUPPLY);
  });
});

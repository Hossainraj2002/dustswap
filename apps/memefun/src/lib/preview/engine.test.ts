import { describe, expect, it } from "vitest";
import { COIN_SUPPLY_HUMAN, DEAD_ADDRESS } from "@/core/constants";
import { PreviewMarket, PreviewTxError } from "./engine";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const USER = "0x00000000000000000000000000000000000000aa" as const;

function market() {
  return new PreviewMarket({ now: NOW, seed: 42 });
}

describe("PreviewMarket", () => {
  it("builds a deterministic market", () => {
    const a = market().listCoins();
    const b = market().listCoins();
    expect(a.length).toBeGreaterThan(40);
    expect(a.map((coin) => [coin.symbol, coin.marketCapUsd])).toEqual(b.map((coin) => [coin.symbol, coin.marketCapUsd]));
  });

  it("keeps every coin's numbers finite and above the opening price", () => {
    for (const coin of market().listCoins()) {
      for (const value of [coin.priceUsd, coin.marketCapUsd, coin.liquidityUsd, coin.volume24hUsd, coin.change1h, coin.change24h, coin.momentum]) {
        expect(Number.isFinite(value), `${coin.symbol}`).toBe(true);
      }
      expect(coin.fdvUsd).toBeGreaterThanOrEqual(coin.openingMarketCapUsd * 0.999);
      expect(coin.sparkline).toHaveLength(48);
    }
  });

  it("conserves supply: pool + wallets + burned = 1B", () => {
    const m = market();
    for (const coin of m.listCoins()) {
      const holders = m.getHolders(coin.address, undefined, 100_000);
      const total = holders.reduce((sum, holder) => sum + holder.balance, 0);
      expect(Math.abs(total / COIN_SUPPLY_HUMAN - 1), coin.symbol).toBeLessThan(1e-9);
      const burn = holders.find((holder) => holder.address === DEAD_ADDRESS);
      if (coin.terms.mode !== "burn") expect(burn).toBeUndefined();
    }
  });

  it("produces a believable spread of market caps", () => {
    const caps = market().listCoins().map((coin) => coin.marketCapUsd).sort((a, b) => b - a);
    expect(caps[0]).toBeGreaterThan(1_000_000);
    expect(caps[caps.length - 1]).toBeLessThan(20_000);
  });

  it("books fees so the visible shares never exceed the total", () => {
    for (const coin of market().listCoins()) {
      const { stats } = coin;
      expect(stats.platformQuote + stats.referralQuote + stats.creatorEarnedQuote).toBeLessThanOrEqual(stats.feesTotalQuote * (1 + 1e-9));
      if (coin.terms.mode === "creator") {
        expect(stats.platformQuote + stats.referralQuote + stats.creatorEarnedQuote).toBeCloseTo(stats.feesTotalQuote, 6);
      }
    }
  });

  it("builds well-formed, continuous candles", () => {
    const m = market();
    const coin = m.listCoins()[0];
    expect(coin).toBeDefined();
    const candles = m.getCandles(coin!.address, 300);
    expect(candles.length).toBeGreaterThan(0);
    for (let i = 0; i < candles.length; i += 1) {
      const candle = candles[i]!;
      expect(candle.low).toBeLessThanOrEqual(Math.min(candle.open, candle.close) + 1e-18);
      expect(candle.high).toBeGreaterThanOrEqual(Math.max(candle.open, candle.close) - 1e-18);
      if (i > 0) {
        expect(candle.time - candles[i - 1]!.time).toBe(300);
        expect(candle.open).toBe(candles[i - 1]!.close);
      }
    }
  });

  it("quotes buys and sells consistently", () => {
    const m = market();
    const coin = m.listCoins().find((entry) => entry.quote.symbol === "ETH" && Date.now() - entry.createdAt > 60_000)!;
    const buy = m.quote(coin.address, "buy", 0.1);
    expect(buy.ok).toBe(true);
    expect(buy.amountOut).toBeGreaterThan(0);
    expect(buy.feeQuote).toBeCloseTo((0.1 * buy.feeBps) / 10_000, 12);
    expect(buy.marketCapAfterUsd).toBeGreaterThan(coin.marketCapUsd);
    const sell = m.quote(coin.address, "sell", buy.amountOut / 10);
    expect(sell.amountOut).toBeGreaterThan(0);
  });

  it("executes a demo trade and updates balances and cost basis", async () => {
    const m = market();
    m.ensureUser(USER);
    const coin = m.listCoins().find((entry) => entry.quote.symbol === "ETH")!;
    const before = m.getQuoteBalance(USER, "ETH");
    const trade = await m.trade(USER, coin.address, "buy", 0.05, 0);
    expect(trade.side).toBe("buy");
    expect(m.getQuoteBalance(USER, "ETH")).toBeCloseTo(before - 0.05, 12);
    expect(m.getCoinBalance(USER, coin.address)).toBeGreaterThan(0);
    expect(m.getPositions(USER).some((position) => position.coin === coin.address)).toBe(true);
  }, 10_000);

  it("refuses trades the wallet cannot pay for", async () => {
    const m = market();
    m.ensureUser(USER, "poor");
    const coin = m.listCoins().find((entry) => entry.quote.symbol === "ETH")!;
    await expect(m.trade(USER, coin.address, "buy", 1, 0)).rejects.toBeInstanceOf(PreviewTxError);
  });

  it("launches a coin with the current settings snapshotted into its terms", async () => {
    const m = market();
    m.ensureUser(USER);
    m.updateSettings({ ...m.getSettings(), platformShareBps: 2500 });
    const coin = await m.launch(USER, {
      name: "Test Coin",
      symbol: "TEST",
      description: "",
      image: "",
      links: {},
      quote: m.listCoins()[0]!.quote,
      feeBps: 200,
      mode: "burn",
      creatorKeepBps: 5000,
      firstBuyQuote: 0,
    });
    expect(coin.terms.platformShareBps).toBe(2500);
    expect(coin.terms.creatorKeepBps).toBe(5000);
    expect(m.listCoins()[0]?.address).toBe(coin.address);
  }, 10_000);
});

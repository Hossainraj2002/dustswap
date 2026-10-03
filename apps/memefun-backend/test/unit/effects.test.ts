import { describe, expect, it } from "vitest";

import {
  type CoinTerms,
  type TradeEvent,
  bucketStart,
  crossedMilestones,
  foldCandle,
  modeName,
  sameBlockIncrement,
  tradeEffects,
} from "../../lib/indexer/effects";
import { priceUsdE18 } from "../../lib/market/math";
import { getSqrtPriceAtTick } from "../../shared/core/uniswap/tickMath";

const ETH_E8 = 300_000_000_000n;
const terms: CoinTerms = {
  mode: 0,
  quoteIsCurrency0: true,
  platformShareBps: 2_000,
  referralShareBps: 2_500,
  creatorKeepBps: 0,
  createdAt: 1_000,
  protectionDurationSec: 15,
};
const quote = { decimals: 18, priceUsdE8: ETH_E8 };
const sqrtBefore = getSqrtPriceAtTick(-200_000);
const sqrtAfter = getSqrtPriceAtTick(-199_000);
const market = { burned: 0n, priceUsdE18: priceUsdE18(sqrtBefore, { quoteIsCurrency0: true, quoteDecimals: 18 }, ETH_E8) };

function trade(overrides: Partial<TradeEvent> = {}): TradeEvent {
  return {
    kind: "trade",
    isBuy: true,
    quoteAmount: 10n ** 18n,
    coinAmount: 123_456n * 10n ** 18n,
    fee: 10n ** 16n,
    referrer: null,
    sqrtPriceX96: sqrtAfter,
    timestamp: 2_000,
    ...overrides,
  };
}

describe("tradeEffects", () => {
  it("a buy: the trader paid the gross amount, the pool got it minus the fee", () => {
    const e = tradeEffects(terms, market, quote, trade());
    expect(e.quoteAmount).toBe(10n ** 18n);
    expect(e.poolQuoteDelta).toBe(10n ** 18n - 10n ** 16n);
    expect(e.poolCoinDelta).toBe(-123_456n * 10n ** 18n);
    expect(e.valueUsdE8).toBe(ETH_E8);
  });

  it("a sell: the pool released the gross amount, the trader received it minus the fee", () => {
    const e = tradeEffects(terms, market, quote, trade({ isBuy: false }));
    expect(e.quoteAmount).toBe(10n ** 18n - 10n ** 16n);
    expect(e.poolQuoteDelta).toBe(-(10n ** 18n));
    expect(e.poolCoinDelta).toBe(123_456n * 10n ** 18n);
  });

  it("splits the fee to the wei, paying a referral only with a referrer", () => {
    const plain = tradeEffects(terms, market, quote, trade({ fee: 1_000_003n }));
    expect(plain.split.referral).toBe(0n);
    expect(plain.split.platform + plain.split.creator + plain.split.destination).toBe(1_000_003n);
    const referred = tradeEffects(terms, market, quote, trade({ fee: 1_000_003n, referrer: "0x00000000000000000000000000000000000000aa" }));
    expect(referred.split.referral).toBe((((1_000_003n * 2_000n) / 10_000n) * 2_500n) / 10_000n);
    expect(referred.split.platform + referred.split.referral + referred.split.creator + referred.split.destination).toBe(1_000_003n);
    const zeroReferrer = tradeEffects(terms, market, quote, trade({ referrer: "0x0000000000000000000000000000000000000000" }));
    expect(zeroReferrer.split.referral).toBe(0n);
  });

  it("community modes send the rest to the destination minus the creator's keep", () => {
    const e = tradeEffects({ ...terms, mode: 1, creatorKeepBps: 1_000 }, market, quote, trade({ fee: 10_000n }));
    expect(e.split.platform).toBe(2_000n);
    expect(e.split.creator).toBe(800n);
    expect(e.split.destination).toBe(7_200n);
  });

  it("marks trades inside launch protection, never the creator's first buy", () => {
    expect(tradeEffects(terms, market, quote, trade({ timestamp: 1_014 })).inProtection).toBe(true);
    expect(tradeEffects(terms, market, quote, trade({ timestamp: 1_015 })).inProtection).toBe(false);
    expect(tradeEffects(terms, market, quote, trade({ timestamp: 1_000, kind: "first_buy" })).inProtection).toBe(false);
  });

  it("reports every milestone a big buy crosses", () => {
    expect(crossedMilestones(9_000n * 10n ** 8n, 80_000n * 10n ** 8n)).toEqual([10_000, 25_000, 69_000]);
    expect(crossedMilestones(10_000n * 10n ** 8n, 10_000n * 10n ** 8n)).toEqual([]);
    expect(crossedMilestones(9_999n * 10n ** 8n, 10_000n * 10n ** 8n)).toEqual([10_000]);
    expect(crossedMilestones(30_000n * 10n ** 8n, 20_000n * 10n ** 8n)).toEqual([]);
  });

  it("knows the four modes", () => {
    expect([0, 1, 2, 3].map(modeName)).toEqual(["creator", "burn", "holders", "floor"]);
    expect(() => modeName(4)).toThrow();
  });
});

describe("candles", () => {
  it("bucket starts on interval boundaries", () => {
    expect(bucketStart(3_599, 3_600)).toBe(0);
    expect(bucketStart(3_600, 3_600)).toBe(3_600);
    expect(bucketStart(86_399 + 86_400, 86_400)).toBe(86_400);
  });

  it("a new candle opens at the previous price, then tracks high, low, close and volume", () => {
    const up = tradeEffects(terms, market, quote, trade());
    const first = foldCandle(null, up, true);
    expect(first.openUsdE18).toBe(market.priceUsdE18);
    expect(first.closeUsdE18).toBe(up.priceUsdE18);
    expect(first.highUsdE18).toBe(up.priceUsdE18 > market.priceUsdE18 ? up.priceUsdE18 : market.priceUsdE18);
    expect(first.lowUsdE18).toBe(up.priceUsdE18 < market.priceUsdE18 ? up.priceUsdE18 : market.priceUsdE18);
    expect(first.trades).toBe(1);
    expect(first.buys).toBe(1);

    const down = tradeEffects(terms, { burned: 0n, priceUsdE18: up.priceUsdE18 }, quote, trade({ isBuy: false, sqrtPriceX96: getSqrtPriceAtTick(-201_000) }));
    const second = foldCandle(first, down, false);
    expect(second.openUsdE18).toBe(first.openUsdE18);
    expect(second.closeUsdE18).toBe(down.priceUsdE18);
    expect(second.lowUsdE18).toBe(down.priceUsdE18 < first.lowUsdE18 ? down.priceUsdE18 : first.lowUsdE18);
    expect(second.volumeQuote).toBe(up.quoteAmount + down.quoteAmount);
    expect(second.trades).toBe(2);
    expect(second.buys).toBe(1);
  });

  it("a coin's first-ever trade opens at the launch price when no prior price exists", () => {
    const e = tradeEffects(terms, { burned: 0n, priceUsdE18: 0n }, quote, trade());
    const candle = foldCandle(null, e, true);
    expect(candle.openUsdE18).toBe(e.priceUsdE18);
    expect(candle.lowUsdE18).toBe(e.priceUsdE18);
  });
});

describe("same-block buys", () => {
  it("counts both wallets when a second buyer shares the block, then one per extra buyer", () => {
    expect([1, 2, 3, 4].map(sameBlockIncrement)).toEqual([0, 2, 1, 1]);
  });
});

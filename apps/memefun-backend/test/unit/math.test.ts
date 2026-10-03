import { describe, expect, it } from "vitest";

import {
  coinValueUsdE8,
  fdvUsdE8,
  marketCapUsdE8,
  priceQuoteWad,
  priceUsdE18,
  quoteValueUsdE8,
} from "../../lib/market/math";
import { COIN_SUPPLY } from "../../shared/core/constants";
import { coinPriceInQuote, startTickExact } from "../../shared/core/pool";
import { getSqrtPriceAtTick } from "../../shared/core/uniswap/tickMath";

const ETH_USD_E8 = 3_000n * 10n ** 8n;
const FDV_E8 = 5_000n * 10n ** 8n;
/** One tick spacing (200 ticks) is a factor of 1.0001^200, about 2.02%. */
const ONE_SPACING = 1.0001 ** 200;

const shapes = [
  { name: "ETH, coin is currency1", quoteIsCurrency0: true, quoteDecimals: 18, quoteUsdE8: ETH_USD_E8 },
  { name: "USDC, coin is currency0", quoteIsCurrency0: false, quoteDecimals: 6, quoteUsdE8: 10n ** 8n },
  { name: "USDC, coin is currency1", quoteIsCurrency0: true, quoteDecimals: 6, quoteUsdE8: 10n ** 8n },
  { name: "8-decimal stock, coin is currency0", quoteIsCurrency0: false, quoteDecimals: 8, quoteUsdE8: 24_110_000_000n },
  { name: "8-decimal stock, coin is currency1", quoteIsCurrency0: true, quoteDecimals: 8, quoteUsdE8: 24_110_000_000n },
];

describe("opening market cap", () => {
  for (const shape of shapes) {
    it(`opens at the $5,000 target, never below it, at most one spacing above (${shape.name})`, () => {
      const tick = startTickExact({
        coinIsCurrency0: !shape.quoteIsCurrency0,
        quoteDecimals: shape.quoteDecimals,
        quoteUsdE8: shape.quoteUsdE8,
        openingFdvUsdE8: FDV_E8,
      });
      const price = priceUsdE18(getSqrtPriceAtTick(tick), shape, shape.quoteUsdE8);
      const mcap = Number(marketCapUsdE8(price, 0n)) / 1e8;
      expect(mcap).toBeGreaterThanOrEqual(4_999.99);
      expect(mcap).toBeLessThanOrEqual(5_000 * ONE_SPACING + 0.01);
    });
  }
});

describe("priceUsdE18 and priceQuoteWad", () => {
  for (const shape of shapes) {
    it(`agree with the app's float price (${shape.name})`, () => {
      for (const tick of [-200_000, -60_000, 0, 60_000, 200_000]) {
        const sqrt = getSqrtPriceAtTick(tick);
        const quotePerCoin = coinPriceInQuote(
          { coinIsCurrency0: !shape.quoteIsCurrency0, coinDecimals: 18, quoteDecimals: shape.quoteDecimals },
          sqrt,
        );
        const wad = Number(priceQuoteWad(sqrt, shape)) / 1e18;
        const usd = Number(priceUsdE18(sqrt, shape, shape.quoteUsdE8)) / 1e18;
        const expectedUsd = quotePerCoin * (Number(shape.quoteUsdE8) / 1e8);
        if (quotePerCoin > 1e-15) expect(wad / quotePerCoin).toBeCloseTo(1, 9);
        if (expectedUsd > 1e-15) expect(usd / expectedUsd).toBeCloseTo(1, 9);
      }
    });
  }

  it("is zero for a missing price", () => {
    expect(priceUsdE18(0n, shapes[0]!, ETH_USD_E8)).toBe(0n);
    expect(priceUsdE18(getSqrtPriceAtTick(0), shapes[0]!, 0n)).toBe(0n);
  });
});

describe("caps and values", () => {
  it("market cap leaves burned coins out, FDV does not", () => {
    const price = 5n * 10n ** 12n; // $0.000005 per coin
    expect(fdvUsdE8(price)).toBe(5_000n * 10n ** 8n);
    expect(marketCapUsdE8(price, 0n)).toBe(5_000n * 10n ** 8n);
    expect(marketCapUsdE8(price, COIN_SUPPLY / 10n)).toBe(4_500n * 10n ** 8n);
    expect(marketCapUsdE8(price, COIN_SUPPLY * 2n)).toBe(0n);
  });

  it("values amounts exactly", () => {
    expect(quoteValueUsdE8(10n ** 18n, 18, ETH_USD_E8)).toBe(ETH_USD_E8);
    expect(quoteValueUsdE8(1_500_000n, 6, 10n ** 8n)).toBe(150_000_000n);
    expect(quoteValueUsdE8(2n * 10n ** 8n, 8, 24_110_000_000n)).toBe(48_220_000_000n);
    expect(coinValueUsdE8(10n ** 24n, 5n * 10n ** 12n)).toBe(5n * 10n ** 8n); // 1M coins at $0.000005
  });
});

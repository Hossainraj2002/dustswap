/**
 * Golden test vectors: the UI's TypeScript math is the spec, and the contracts must agree with
 * it to the wei. This writes the TS results to packages/memefun-contracts/test/vectors/*.json;
 * the Foundry suite (test/unit/Vectors.t.sol) replays every case against FeeMath and LaunchMath.
 *
 *   pnpm vectors
 *
 * Deterministic: the same seed always produces the same files, so a diff means the math changed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchFeeBps } from "../src/core/antiSnipe";
import { COIN_SUPPLY, TICK_SPACING } from "../src/core/constants";
import { feeOnAmount, feeOnNet, splitFee } from "../src/core/fees";
import { MAX_LIQUIDITY_PER_TICK, openingSqrtPriceX96, startTickExact, toUsdE8 } from "../src/core/pool";
import type { FeeMode } from "../src/core/types";
import { type Position, swapExactIn } from "../src/core/uniswap/swap";
import {
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  maxUsableTick,
  minUsableTick,
} from "../src/core/uniswap/tickMath";
import { getAmount0Delta, getAmount1Delta, getLiquidityForAmount0, getLiquidityForAmount1 } from "../src/core/uniswap/sqrtPriceMath";
import { createRng } from "../src/lib/preview/random";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../../packages/memefun-contracts/test/vectors");
const rng = createRng(0x6d656d65);

const MODES: FeeMode[] = ["creator", "burn", "holders", "floor"];
const MODE_INDEX: Record<FeeMode, number> = { creator: 0, burn: 1, holders: 2, floor: 3 };

function int(max: number): number {
  return Math.floor(rng() * (max + 1));
}

function bigRandom(bits: number): bigint {
  let value = 0n;
  for (let i = 0; i < bits; i += 30) value = (value << 30n) | BigInt(Math.floor(rng() * 2 ** 30));
  return value & ((1n << BigInt(bits)) - 1n);
}

function write(name: string, cases: Array<Record<string, string | boolean>>) {
  mkdirSync(outDir, { recursive: true });
  const body = { generatedBy: "apps/memefun/scripts/vectors.ts", count: String(cases.length), cases };
  writeFileSync(resolve(outDir, `${name}.json`), `${JSON.stringify(body, null, 1)}\n`);
  console.log(`${name}.json: ${cases.length} cases`);
}

// ---- fees: gross and net formulas, edges first ----------------------------------------------
const fees: Array<Record<string, string | boolean>> = [];
const edgeAmounts = [0n, 1n, 2n, 9_999n, 10_000n, 10_001n, 10n ** 18n, (1n << 128n) - 1n];
const edgeBps = [0, 1, 99, 100, 500, 1_000, 5_000, 9_900, 9_999];
for (const amount of edgeAmounts) for (const bps of edgeBps) fees.push(feeCase(amount, bps));
for (let i = 0; i < 140; i++) fees.push(feeCase(bigRandom(8 + int(150)), int(9_999)));
write("fees", fees);

function feeCase(amount: bigint, bps: number) {
  return { amount: String(amount), bps: String(bps), gross: String(feeOnAmount(amount, bps)), net: String(feeOnNet(amount, bps)) };
}

// ---- splits ----------------------------------------------------------------------------------
const splits: Array<Record<string, string | boolean>> = [];
for (let i = 0; i < 200; i++) {
  const mode = MODES[i % 4] as FeeMode;
  const fee = i < 8 ? BigInt(i) : bigRandom(4 + int(120));
  const config = { mode, platformShareBps: int(5_000), referralShareBps: int(5_000), creatorKeepBps: int(5_000) };
  const hasReferrer = rng() < 0.5;
  const s = splitFee(fee, config, hasReferrer);
  splits.push({
    fee: String(fee),
    mode: String(MODE_INDEX[mode]),
    platformShareBps: String(config.platformShareBps),
    referralShareBps: String(config.referralShareBps),
    creatorKeepBps: String(config.creatorKeepBps),
    hasReferrer,
    platform: String(s.platform),
    referral: String(s.referral),
    creator: String(s.creator),
    destination: String(s.destination),
  });
}
write("splits", splits);

// ---- launch protection schedule --------------------------------------------------------------
const protection: Array<Record<string, string | boolean>> = [];
// The default schedule second by second, then random schedules.
for (let elapsed = 0; elapsed <= 17; elapsed++) protection.push(protectionCase(100, 5_000, 15, elapsed));
for (let i = 0; i < 130; i++) protection.push(protectionCase(int(1_000), int(9_900), int(300), int(400)));
write("protection", protection);

function protectionCase(base: number, start: number, duration: number, elapsed: number) {
  return {
    base: String(base),
    start: String(start),
    duration: String(duration),
    elapsed: String(elapsed),
    bps: String(launchFeeBps(base, { startBps: start, durationSec: duration }, elapsed)),
  };
}

// ---- launch positions ------------------------------------------------------------------------
const launches: Array<Record<string, string | boolean>> = [];
const quotes = [
  { decimals: 18, usd: [100, 500, 1_000, 2_751.1205, 10_000, 100_000] },
  { decimals: 6, usd: [0.9998, 1, 1.0002] },
  // 8-decimal stocks, including prices that take the reduced-precision branch at low FDVs.
  { decimals: 8, usd: [1, 12.5, 330.375, 1_850, 5_000, 10_000] },
];
const fdvs = [1_000, 5_000, 69_000, 1_000_000];
for (const quote of quotes) {
  for (const usd of quote.usd) {
    for (const fdv of fdvs) {
      for (const coinIsCurrency0 of [false, true]) launches.push(launchCase(coinIsCurrency0, quote.decimals, toUsdE8(usd), toUsdE8(fdv)));
    }
  }
}
for (let i = 0, added = 0; added < 40 && i < 400; i++) {
  const decimals = [6, 8, 18][i % 3] as number;
  try {
    launches.push(launchCase(rng() < 0.5, decimals, BigInt(1 + int(10 ** 12)), BigInt(1_000e8 + int(999_000) * 1e8)));
    added++;
  } catch {
    // Outside the launchable range; the contract reverts there too (covered by fuzz tests).
  }
}
write("launches", launches);

function launchCase(coinIsCurrency0: boolean, quoteDecimals: number, quoteUsdE8: bigint, fdvUsdE8: bigint) {
  const input = { coinIsCurrency0, quoteDecimals, quoteUsdE8, openingFdvUsdE8: fdvUsdE8 };
  const sqrtPriceX96 = openingSqrtPriceX96(input);
  const startTick = startTickExact(input);
  const tickLower = coinIsCurrency0 ? startTick : minUsableTick(TICK_SPACING);
  const tickUpper = coinIsCurrency0 ? maxUsableTick(TICK_SPACING) : startTick;
  const sqrtLower = getSqrtPriceAtTick(tickLower);
  const sqrtUpper = getSqrtPriceAtTick(tickUpper);
  const liquidity = coinIsCurrency0
    ? getLiquidityForAmount0(sqrtLower, sqrtUpper, COIN_SUPPLY)
    : getLiquidityForAmount1(sqrtLower, sqrtUpper, COIN_SUPPLY);
  if (liquidity > MAX_LIQUIDITY_PER_TICK) throw new RangeError("not launchable: liquidity above the per-tick cap");
  return {
    coinIsCurrency0,
    quoteDecimals: String(quoteDecimals),
    quoteUsdE8: String(quoteUsdE8),
    fdvUsdE8: String(fdvUsdE8),
    sqrtPriceX96: String(sqrtPriceX96),
    startTick: String(startTick),
    tickLower: String(tickLower),
    tickUpper: String(tickUpper),
    liquidity: String(liquidity),
  };
}

// ---- swaps: v4's exact-input swap loop over memefun-shaped pools -----------------------------
// Each case is a pool (fee 0, spacing 200) built and traded op by op: liquidity adds and swaps.
// The Foundry suite (test/unit/SwapVectors.t.sol) runs the same ops on a real PoolManager and
// checks every swap's input, output, price and tick, so trade quotes in the app equal the fills.
const swapRng = createRng(0x73776170);
const sInt = (max: number) => Math.floor(swapRng() * (max + 1));
const SPACING = TICK_SPACING;
const WORD = 256 * SPACING;
/** Positions stay far below int128, the bound on every PoolManager balance delta. */
const MAX_TOKEN_AMOUNT = 1n << 100n;

type SwapOp =
  | { kind: "0"; tickLower: string; tickUpper: string; liquidity: string }
  | {
      kind: "1";
      zeroForOne: boolean;
      amountIn: string;
      amountInUsed: string;
      amountOut: string;
      sqrtPriceAfterX96: string;
      tickAfter: string;
    };

interface SwapCaseJson {
  sqrtPriceX96: string;
  opCount: string;
  ops: SwapOp[];
}

/** 10^lo .. 10^hi, log-uniform, as an integer (at least 1). */
function logUniform(lo: number, hi: number): bigint {
  const exp = lo + swapRng() * (hi - lo);
  const whole = Math.floor(exp);
  const mantissa = BigInt(Math.floor(10 ** (exp - whole) * 1e6));
  const value = (mantissa * 10n ** BigInt(Math.max(0, whole))) / 1_000_000n;
  return value > 0n ? value : 1n;
}

class SwapCaseBuilder {
  readonly ops: SwapOp[] = [];
  readonly positions: Position[] = [];
  sqrtPriceX96: bigint;
  tick: number;

  constructor(readonly initialSqrtPriceX96: bigint) {
    this.sqrtPriceX96 = initialSqrtPriceX96;
    this.tick = getTickAtSqrtPrice(initialSqrtPriceX96);
  }

  /**
   * Adds a position the way PoolManager.modifyLiquidity would accept it: token amounts at the
   * current price fit comfortably in int128 and no tick exceeds the per-tick liquidity cap.
   * Returns false (and adds nothing) otherwise.
   */
  add(tickLower: number, tickUpper: number, liquidity: bigint): boolean {
    if (liquidity <= 0n || tickLower >= tickUpper) return false;
    const sqrtLower = getSqrtPriceAtTick(tickLower);
    const sqrtUpper = getSqrtPriceAtTick(tickUpper);
    const [amount0, amount1] =
      this.tick < tickLower
        ? [getAmount0Delta(sqrtLower, sqrtUpper, liquidity, true), 0n]
        : this.tick < tickUpper
          ? [getAmount0Delta(this.sqrtPriceX96, sqrtUpper, liquidity, true), getAmount1Delta(sqrtLower, this.sqrtPriceX96, liquidity, true)]
          : [0n, getAmount1Delta(sqrtLower, sqrtUpper, liquidity, true)];
    if (amount0 > MAX_TOKEN_AMOUNT || amount1 > MAX_TOKEN_AMOUNT) return false;
    for (const tick of [tickLower, tickUpper]) {
      const gross = this.positions.reduce((sum, p) => (p.tickLower === tick || p.tickUpper === tick ? sum + p.liquidity : sum), liquidity);
      if (gross > MAX_LIQUIDITY_PER_TICK) return false;
    }
    this.positions.push({ tickLower, tickUpper, liquidity });
    this.ops.push({ kind: "0", tickLower: String(tickLower), tickUpper: String(tickUpper), liquidity: String(liquidity) });
    return true;
  }

  swap(zeroForOne: boolean, amountIn: bigint) {
    const r = swapExactIn(
      { sqrtPriceX96: this.sqrtPriceX96, tick: this.tick, positions: this.positions, tickSpacing: SPACING },
      zeroForOne,
      amountIn,
    );
    this.ops.push({
      kind: "1",
      zeroForOne,
      amountIn: String(amountIn),
      amountInUsed: String(r.amountIn),
      amountOut: String(r.amountOut),
      sqrtPriceAfterX96: String(r.sqrtPriceAfterX96),
      tickAfter: String(r.tickAfter),
    });
    this.sqrtPriceX96 = r.sqrtPriceAfterX96;
    this.tick = r.tickAfter;
    return r;
  }

  json(): SwapCaseJson {
    return { sqrtPriceX96: String(this.initialSqrtPriceX96), opCount: String(this.ops.length), ops: this.ops };
  }
}

const swapCases: SwapCaseJson[] = [];
const swapStats = { swaps: 0, partial: 0, wordEdges: 0, floorCrossings: 0 };

function track(c: SwapCaseBuilder, zeroForOne: boolean, amountIn: bigint, floorEdges: number[] = []) {
  // PoolManager refuses a swap toward a limit the price already sits at (PriceLimitAlreadyExceeded).
  if (zeroForOne ? c.sqrtPriceX96 <= MIN_SQRT_PRICE + 1n : c.sqrtPriceX96 >= MAX_SQRT_PRICE - 1n) return null;
  const before = c.tick;
  const r = c.swap(zeroForOne, amountIn);
  swapStats.swaps++;
  if (r.partial) swapStats.partial++;
  if (Math.floor(before / WORD) !== Math.floor(c.tick / WORD)) swapStats.wordEdges++;
  const lo = Math.min(before, c.tick);
  const hi = Math.max(before, c.tick);
  if (floorEdges.some((edge) => edge > lo && edge <= hi)) swapStats.floorCrossings++;
  return r;
}

// memefun pools: a launch, buys that move the price, floor bands placed as FloorVault places them
// (2x to 10x under the price, quote only), then sells that run down into them and back up.
const swapQuotes = [
  { decimals: 18, usd: 2_660 },
  { decimals: 6, usd: 1 },
  { decimals: 8, usd: 240 },
];
for (let i = 0; i < 72; i++) {
  const quote = swapQuotes[i % 3]!;
  const coinIsCurrency0 = i % 2 === 1;
  const fdv = [1_000, 5_000, 69_000][Math.floor(i / 6) % 3]!;
  const startTick = startTickExact({
    coinIsCurrency0,
    quoteDecimals: quote.decimals,
    quoteUsdE8: toUsdE8(quote.usd),
    openingFdvUsdE8: toUsdE8(fdv),
  });
  const tickLower = coinIsCurrency0 ? startTick : minUsableTick(SPACING);
  const tickUpper = coinIsCurrency0 ? maxUsableTick(SPACING) : startTick;
  const liquidity = coinIsCurrency0
    ? getLiquidityForAmount0(getSqrtPriceAtTick(tickLower), getSqrtPriceAtTick(tickUpper), COIN_SUPPLY)
    : getLiquidityForAmount1(getSqrtPriceAtTick(tickLower), getSqrtPriceAtTick(tickUpper), COIN_SUPPLY);
  const c = new SwapCaseBuilder(getSqrtPriceAtTick(startTick));
  c.add(tickLower, tickUpper, liquidity);
  // A buy sends the quote in; the quote is currency0 exactly when the coin is currency1.
  const buy = !coinIsCurrency0;
  const quoteUnitsPerUsd = 10 ** quote.decimals / quote.usd;

  // Buys from a cent to $100k, so the large ones move the price across bitmap words.
  let coinsBought = 0n;
  let quoteIn = 0n;
  let soldOut = false;
  for (let b = 0, buys = 1 + sInt(3); b < buys; b++) {
    const usd = 10 ** (-2 + swapRng() * 7);
    const r = track(c, buy, BigInt(Math.max(1, Math.floor(usd * quoteUnitsPerUsd))));
    coinsBought += r?.amountOut ?? 0n;
    quoteIn += r?.amountIn ?? 0n;
    soldOut ||= r?.partial ?? true;
  }

  // Floor bands from part of the quote that came in, placed from the price at the time, as
  // FloorVault places them. (Not after a buy that emptied the pool: no fees could buy a band there.)
  const floorEdges: number[] = [];
  for (let f = 0, bands = soldOut ? 0 : sInt(3); f < bands; f++) {
    const near = 6_932 + sInt(4) * SPACING;
    const far = 23_027 - sInt(4) * SPACING;
    const [lower, upper] = coinIsCurrency0
      ? // Quote is currency1: the band sits below the price.
        [
          Math.ceil(Math.max(c.tick - far, minUsableTick(SPACING)) / SPACING) * SPACING,
          Math.floor((c.tick - near) / SPACING) * SPACING,
        ]
      : // Quote is currency0: the band sits above the price.
        [
          Math.ceil((c.tick + near) / SPACING) * SPACING,
          Math.floor(Math.min(c.tick + far, maxUsableTick(SPACING)) / SPACING) * SPACING,
        ];
    if (lower >= upper) continue;
    const quoteForBand = (quoteIn * BigInt(1 + sInt(30))) / 100n;
    const sqrtLower = getSqrtPriceAtTick(lower);
    const sqrtUpper = getSqrtPriceAtTick(upper);
    const bandLiquidity = coinIsCurrency0
      ? getLiquidityForAmount1(sqrtLower, sqrtUpper, quoteForBand)
      : getLiquidityForAmount0(sqrtLower, sqrtUpper, quoteForBand);
    if (c.add(lower, upper, bandLiquidity)) floorEdges.push(lower, upper);
  }

  // Sells: parts of what was bought, sometimes much more, which runs the price through the launch
  // position, into the floor bands and, past everything, to the swap's limit.
  for (let s = 0, sells = 1 + sInt(3); s < sells; s++) {
    const share = [0.05, 0.3, 0.7, 1, 1.4, 4][sInt(5)]!;
    const amount = (coinsBought * BigInt(Math.round(share * 1_000))) / 1_000n;
    track(c, !buy, amount > 0n ? amount : logUniform(15, 24), floorEdges);
  }
  track(c, buy, logUniform(quote.decimals - 3, quote.decimals + 2), floorEdges);
  swapCases.push(c.json());
}

// Generic pools around bitmap word edges: overlapping positions, gaps, shared edges and swaps
// both ways, some starting exactly on an initialized tick.
for (let i = 0; i < 48; i++) {
  const center = (sInt(30) - 15) * WORD + (sInt(40) - 20) * SPACING;
  const c = new SwapCaseBuilder(getSqrtPriceAtTick(i % 4 === 0 ? center : center + 1 + sInt(SPACING - 2)));
  const edges: number[] = [];
  for (let p = 0, n = 2 + sInt(4); p < n; p++) {
    const width = (1 + sInt(400)) * SPACING;
    // Every third position starts on an edge already in use.
    const lower =
      edges.length > 0 && p % 3 === 2
        ? edges[sInt(edges.length - 1)]!
        : Math.max(center + (sInt(600) - 300) * SPACING, minUsableTick(SPACING));
    const upper = Math.min(lower + width, maxUsableTick(SPACING));
    if (lower >= upper) continue;
    if (c.add(lower, upper, logUniform(15, 28))) edges.push(lower, upper);
  }
  for (let s = 0, n = 2 + sInt(5); s < n; s++) track(c, swapRng() < 0.5, logUniform(8, 27));
  swapCases.push(c.json());
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, "swaps.json"),
  `${JSON.stringify({ generatedBy: "apps/memefun/scripts/vectors.ts", count: String(swapCases.length), cases: swapCases }, null, 1)}\n`,
);
console.log(
  `swaps.json: ${swapCases.length} cases, ${swapStats.swaps} swaps (${swapStats.partial} partial, ${swapStats.wordEdges} across a word edge, ${swapStats.floorCrossings} into a floor band)`,
);

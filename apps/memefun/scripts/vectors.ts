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
import { getSqrtPriceAtTick, maxUsableTick, minUsableTick } from "../src/core/uniswap/tickMath";
import { getLiquidityForAmount0, getLiquidityForAmount1 } from "../src/core/uniswap/sqrtPriceMath";
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

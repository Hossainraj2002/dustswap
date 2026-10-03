/**
 * Exact port of Uniswap v4 TickMath (identical to v3) using bigint.
 * Results match the on-chain library bit for bit.
 */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
const MAX_UINT256 = (1n << 256n) - 1n;

const RATIO_FACTORS: ReadonlyArray<readonly [bigint, bigint]> = [
  [0x2n, 0xfff97272373d413259a46990580e213an],
  [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];

/** sqrt(1.0001^tick) * 2^96, rounded up, exactly as TickMath.getSqrtPriceAtTick. */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`tick out of range: ${tick}`);
  }
  const absTick = BigInt(Math.abs(tick));
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : Q128;
  for (const [mask, factor] of RATIO_FACTORS) {
    if ((absTick & mask) !== 0n) ratio = (ratio * factor) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Q128.128 -> Q64.96, rounding up.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/**
 * Greatest tick whose sqrt price is <= sqrtPriceX96 (TickMath.getTickAtSqrtPrice).
 * A float estimate is corrected with exact comparisons, so the result is exact.
 */
export function getTickAtSqrtPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) {
    throw new RangeError("sqrtPriceX96 out of range");
  }
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  let tick = Math.floor((2 * Math.log(ratio)) / Math.log(1.0001));
  tick = Math.max(MIN_TICK, Math.min(MAX_TICK - 1, tick));
  while (tick > MIN_TICK && getSqrtPriceAtTick(tick) > sqrtPriceX96) tick -= 1;
  while (tick < MAX_TICK - 1 && getSqrtPriceAtTick(tick + 1) <= sqrtPriceX96) tick += 1;
  return tick;
}

export function minUsableTick(tickSpacing: number): number {
  return Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
}

export function maxUsableTick(tickSpacing: number): number {
  return Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
}

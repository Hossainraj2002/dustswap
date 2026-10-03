/**
 * Exact-input swap through ONE concentrated-liquidity position with a 0 LP fee
 * (memefun pools charge their fee in the hook, never in the LP fee). This is
 * SwapMath.computeSwapStep for exact input, clamped to the position's range, so
 * a launch pool's quotes match the chain.
 */
import { getSqrtPriceAtTick } from "./tickMath";
import {
  getAmount0Delta,
  getAmount1Delta,
  getNextSqrtPriceFromInput,
} from "./sqrtPriceMath";

export interface PositionPool {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
}

export interface SwapStepResult {
  /** Input actually consumed (less than requested only on a partial fill). */
  amountIn: bigint;
  amountOut: bigint;
  sqrtPriceAfterX96: bigint;
  /** True when the swap ran into the edge of the position's range. */
  partial: boolean;
}

export function swapExactInSinglePosition(
  pool: PositionPool,
  zeroForOne: boolean,
  amountIn: bigint,
): SwapStepResult {
  if (amountIn < 0n) throw new RangeError("amountIn must be non-negative");
  const sqrtLower = getSqrtPriceAtTick(pool.tickLower);
  const sqrtUpper = getSqrtPriceAtTick(pool.tickUpper);
  const current = pool.sqrtPriceX96;

  // The position only provides liquidity strictly inside its price range in
  // the swap direction; outside it there is nothing to trade against.
  const target = zeroForOne ? sqrtLower : sqrtUpper;
  const hasRoom = zeroForOne ? current > target : current < target;
  if (amountIn === 0n || pool.liquidity === 0n || !hasRoom) {
    return { amountIn: 0n, amountOut: 0n, sqrtPriceAfterX96: current, partial: amountIn > 0n };
  }

  const maxIn = zeroForOne
    ? getAmount0Delta(target, current, pool.liquidity, true)
    : getAmount1Delta(current, target, pool.liquidity, true);

  let sqrtNext: bigint;
  let consumed: bigint;
  let partial = false;
  if (amountIn >= maxIn) {
    sqrtNext = target;
    consumed = maxIn;
    partial = amountIn > maxIn;
  } else {
    sqrtNext = getNextSqrtPriceFromInput(current, pool.liquidity, amountIn, zeroForOne);
    consumed = amountIn;
  }

  const amountOut = zeroForOne
    ? getAmount1Delta(sqrtNext, current, pool.liquidity, false)
    : getAmount0Delta(current, sqrtNext, pool.liquidity, false);

  return { amountIn: consumed, amountOut, sqrtPriceAfterX96: sqrtNext, partial };
}

/**
 * Exact bigint port of the Uniswap v4 SqrtPriceMath / FullMath /
 * LiquidityAmounts functions a single-position launch pool needs.
 */
import { Q96 } from "./tickMath";

const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("mulDiv by zero");
  return (a * b) / denominator;
}

export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("mulDiv by zero");
  const product = a * b;
  const result = product / denominator;
  return product % denominator === 0n ? result : result + 1n;
}

export function divRoundingUp(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError("div by zero");
  return a / b + (a % b === 0n ? 0n : 1n);
}

function sortPair(a: bigint, b: bigint): [bigint, bigint] {
  return a > b ? [b, a] : [a, b];
}

/** Amount of currency0 between two prices for `liquidity`. */
export function getAmount0Delta(
  sqrtPriceA: bigint,
  sqrtPriceB: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const [lower, upper] = sortPair(sqrtPriceA, sqrtPriceB);
  if (lower <= 0n) throw new RangeError("sqrt price must be positive");
  const numerator1 = liquidity << 96n;
  const numerator2 = upper - lower;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, upper), lower)
    : mulDiv(numerator1, numerator2, upper) / lower;
}

/** Amount of currency1 between two prices for `liquidity`. */
export function getAmount1Delta(
  sqrtPriceA: bigint,
  sqrtPriceB: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const [lower, upper] = sortPair(sqrtPriceA, sqrtPriceB);
  return roundUp
    ? mulDivRoundingUp(liquidity, upper - lower, Q96)
    : mulDiv(liquidity, upper - lower, Q96);
}

export function getNextSqrtPriceFromAmount0RoundingUp(
  sqrtPrice: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (amount === 0n) return sqrtPrice;
  const numerator1 = liquidity << 96n;
  const product = amount * sqrtPrice;
  if (add) {
    // Mirrors the uint256 overflow branch of the Solidity implementation.
    if (product <= MAX_UINT256) {
      const denominator = numerator1 + product;
      if (denominator <= MAX_UINT256) {
        return mulDivRoundingUp(numerator1, sqrtPrice, denominator);
      }
    }
    return divRoundingUp(numerator1, numerator1 / sqrtPrice + amount);
  }
  if (product > MAX_UINT256 || numerator1 <= product) {
    throw new RangeError("price overflow");
  }
  const denominator = numerator1 - product;
  const next = mulDivRoundingUp(numerator1, sqrtPrice, denominator);
  if (next > MAX_UINT160) throw new RangeError("price overflow");
  return next;
}

export function getNextSqrtPriceFromAmount1RoundingDown(
  sqrtPrice: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (add) {
    const quotient = amount <= MAX_UINT160 ? (amount << 96n) / liquidity : mulDiv(amount, Q96, liquidity);
    const next = sqrtPrice + quotient;
    if (next > MAX_UINT160) throw new RangeError("price overflow");
    return next;
  }
  const quotient =
    amount <= MAX_UINT160
      ? divRoundingUp(amount << 96n, liquidity)
      : mulDivRoundingUp(amount, Q96, liquidity);
  if (sqrtPrice <= quotient) throw new RangeError("not enough liquidity");
  return sqrtPrice - quotient;
}

export function getNextSqrtPriceFromInput(
  sqrtPrice: bigint,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
): bigint {
  if (sqrtPrice <= 0n || liquidity <= 0n) throw new RangeError("invalid pool state");
  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPrice, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtPrice, liquidity, amountIn, true);
}

/** LiquidityAmounts.getLiquidityForAmount0, rounded down. */
export function getLiquidityForAmount0(sqrtPriceA: bigint, sqrtPriceB: bigint, amount0: bigint): bigint {
  const [lower, upper] = sortPair(sqrtPriceA, sqrtPriceB);
  const intermediate = mulDiv(lower, upper, Q96);
  return mulDiv(amount0, intermediate, upper - lower);
}

/** LiquidityAmounts.getLiquidityForAmount1, rounded down. */
export function getLiquidityForAmount1(sqrtPriceA: bigint, sqrtPriceB: bigint, amount1: bigint): bigint {
  const [lower, upper] = sortPair(sqrtPriceA, sqrtPriceB);
  return mulDiv(amount1, Q96, upper - lower);
}

import { type Address, type Hex, encodeAbiParameters, getAddress, keccak256 } from "viem";

import { TICK_SPACING } from "../../shared/core/constants";

/** Every memefun pool: fee 0 (the hook charges the fee), tick spacing 200, the memefun hook. */
export function memefunPoolId(coin: Address, quote: Address, hook: Address): Hex {
  const [currency0, currency1] = BigInt(coin) < BigInt(quote) ? [coin, quote] : [quote, coin];
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, 0, TICK_SPACING, hook],
    ),
  );
}

/**
 * The pair asset of a pool, found by recomputing its PoolId over the listed quotes. The hook's
 * PoolRegistered event names the coin and pool id but not the pair asset, and this avoids a
 * contract read per launch.
 */
export function resolveQuote(poolId: Hex, coin: Address, hook: Address, candidates: readonly Address[]): Address | null {
  const target = poolId.toLowerCase();
  for (const candidate of candidates) {
    if (memefunPoolId(coin, candidate, hook).toLowerCase() === target) return getAddress(candidate);
  }
  return null;
}

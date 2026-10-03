import { getAddress } from "viem";

import { rows } from "../../lib/db";
import { memeFunConfigAbi } from "../../shared/abis";
import type { KeeperContext } from "../context";
import { simulateAndSend } from "../tx";

const MIN_MOVE_BPS = 50n; // 0.5%
const REFRESH_AFTER_SEC = 12 * 3_600;
const MAX_STEP_BPS = 2_000n; // the contract's MAX_MANUAL_PRICE_MOVE_BPS for the price keeper

/** Where the next on-chain price goes: the target, but never more than 20% from the current one. */
export function nextManualPrice(current: bigint, target: bigint): { next: bigint; capped: boolean } {
  const maxMove = (current * MAX_STEP_BPS) / 10_000n;
  if (target > current + maxMove) return { next: current + maxMove, capped: true };
  if (target < current - maxMove) return { next: current - maxMove, capped: true };
  return { next: target, capped: false };
}

export function needsUpdate(current: bigint, target: bigint, ageSec: number): boolean {
  if (ageSec >= REFRESH_AFTER_SEC) return true;
  if (current <= 0n) return true;
  const diff = target > current ? target - current : current - target;
  return diff * 10_000n >= current * MIN_MOVE_BPS;
}

/**
 * Tokenized-stock prices (MANUAL quotes): keeps each on-chain price within reach of the stock's
 * NAV so new launches on that pair open at the right market cap. Prices only place opening
 * prices; trading never reads them.
 */
export async function runStockPrices(ctx: KeeperContext): Promise<{ updated: number }> {
  const manual = await rows<{ address: string; symbol: string }>(ctx.index, `SELECT address, symbol FROM quote WHERE source = 2`);
  const now = await ctx.chainNow();
  let updated = 0;
  for (const row of manual) {
    const quote = getAddress(row.address);
    const onchain = await ctx.client.readContract({ address: ctx.deployment.config, abi: memeFunConfigAbi, functionName: "quote", args: [quote] });
    const current = BigInt(onchain.priceUsdE8);
    const target = await ctx.prices.usdE8({ address: quote, symbol: row.symbol, currentUsdE8: current, nowSec: now }).catch(() => null);
    if (target === null) {
      ctx.log("price.unavailable", { quote, symbol: row.symbol, source: ctx.prices.kind });
      continue;
    }
    const age = now - Number(onchain.priceUpdatedAt);
    if (!needsUpdate(current, target, age)) continue;
    const { next, capped } = nextManualPrice(current, target);
    const outcome = await simulateAndSend(ctx, ctx.wallets.priceKeeper, {
      address: ctx.deployment.config,
      abi: memeFunConfigAbi,
      functionName: "setManualPrice",
      args: [quote, next],
    });
    if (outcome.kind === "no_wallet") {
      ctx.log("price.no_wallet", { quote });
      return { updated };
    }
    if (outcome.kind === "reverted") {
      await ctx.app.logKeeperRun({ job: "stock_price", target: row.address, status: "failed", detail: { reason: outcome.error, from: current, to: next } });
      ctx.log("price.failed", { quote, reason: outcome.error });
      continue;
    }
    updated += 1;
    await ctx.app.logKeeperRun({
      job: "stock_price",
      target: row.address,
      status: outcome.kind === "sent" ? "ok" : "dry_run",
      detail: { symbol: row.symbol, from: current, to: next, target, capped, ageSec: age },
      txHash: outcome.kind === "sent" ? outcome.hash : null,
    });
    // A move beyond the keeper's 20% step needs the owner: say so loudly.
    if (capped) ctx.log("price.alert", { quote, symbol: row.symbol, current, target, applied: next, note: "NAV moved more than 20%; owner action needed" });
    else ctx.log("price.updated", { quote, symbol: row.symbol, from: current, to: next });
  }
  return { updated };
}

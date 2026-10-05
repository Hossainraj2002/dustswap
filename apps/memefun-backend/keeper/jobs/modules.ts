import { getAddress } from "viem";

import { rows } from "../../lib/db";
import { quoteValueUsdE8 } from "../../lib/market/math";
import { buybackBurnVaultAbi, feeVaultAbi, floorVaultAbi } from "../../shared/abis";
import type { KeeperContext } from "../context";
import { simulateAndSend } from "../tx";

interface ModeCoin {
  address: string;
  quote: string;
  pool_id: string;
  decimals: number;
  price_usd_e_8: string;
}

const BUYBACK_COOLDOWN = 600;
const FLOOR_COOLDOWN = 3_600;
const MAX_PER_RUN = 20;

async function coinsInMode(ctx: KeeperContext, mode: number) {
  return rows<ModeCoin>(
    ctx.index,
    `SELECT c.address, m.quote, m.pool_id, q.decimals, q.price_usd_e_8 FROM coin c JOIN market m ON m.address = c.address JOIN quote q ON q.address = m.quote
      WHERE c.launched = true AND c.mode = $1 ORDER BY c.last_trade_at DESC`,
    [mode],
  );
}

/**
 * Buyback and burn: for each burn-mode coin whose accrued fees (still in FeeVault, plus what the
 * vault kept from earlier rounds) are worth at least the threshold and whose 10-minute cooldown
 * has passed, call executeBuyback. Anyone may call it; the contract decides how much it can spend
 * without moving the price more than ~2%, and refuses if the price was pumped in the same block.
 */
export async function runBuybacks(ctx: KeeperContext): Promise<{ executed: number; skipped: number }> {
  const d = ctx.deployment;
  const now = await ctx.chainNow();
  let executed = 0;
  let skipped = 0;
  for (const c of (await coinsInMode(ctx, 1)).slice(0, 500)) {
    if (executed >= MAX_PER_RUN) break;
    const coin = getAddress(c.address);
    const quote = getAddress(c.quote);
    const [pending, leftover, last] = await Promise.all([
      ctx.client.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "destinationPendingFor", args: [coin, quote] }),
      ctx.client.readContract({ address: d.buybackBurnVault, abi: buybackBurnVaultAbi, functionName: "balanceOfFor", args: [coin, quote] }),
      ctx.client.readContract({ address: d.buybackBurnVault, abi: buybackBurnVaultAbi, functionName: "lastBuybackAtFor", args: [coin, quote] }),
    ]);
    const budgetUsdE8 = quoteValueUsdE8(pending + leftover, c.decimals, BigInt(c.price_usd_e_8));
    if (budgetUsdE8 < ctx.thresholds.buybackMinUsdE8) continue;
    if (last !== 0n && BigInt(now) < last + BigInt(BUYBACK_COOLDOWN)) continue;

    const outcome = await simulateAndSend<readonly [bigint, bigint]>(ctx, ctx.wallets.keeper, {
      address: d.buybackBurnVault,
      abi: buybackBurnVaultAbi,
      functionName: "executeBuybackFor",
      args: [coin, quote],
    });
    if (outcome.kind === "no_wallet") {
      ctx.log("buyback.no_wallet", { coin });
      return { executed, skipped };
    }
    if (outcome.kind === "reverted") {
      skipped += 1;
      // PricePumped is the contract protecting the buyback: try again next round.
      const expected = ["PricePumped", "CoolingDown", "NothingToBuy"].includes(outcome.error);
      await ctx.app.logKeeperRun({ job: "buyback", target: c.pool_id, status: expected ? "skipped" : "failed", detail: { reason: outcome.error } });
      ctx.log("buyback.skipped", { coin, reason: outcome.error });
      continue;
    }
    const [spent, burned] = outcome.result;
    executed += 1;
    await ctx.app.logKeeperRun({
      job: "buyback",
      target: c.pool_id,
      status: outcome.kind === "sent" ? "ok" : "dry_run",
      detail: { spent, burned, budgetUsdE8 },
      txHash: outcome.kind === "sent" ? outcome.hash : null,
    });
    ctx.log("buyback.done", { coin, spent, burned, tx: outcome.kind === "sent" ? outcome.hash : "dry-run" });
  }
  return { executed, skipped };
}

/**
 * Liquidity floor: for each floor-mode coin with enough accrued fees and its hourly cooldown
 * passed, call addFloor, which places them as quote-only liquidity 2x to 10x under the price.
 */
export async function runFloors(ctx: KeeperContext): Promise<{ executed: number; skipped: number }> {
  const d = ctx.deployment;
  const now = await ctx.chainNow();
  let executed = 0;
  let skipped = 0;
  for (const c of (await coinsInMode(ctx, 3)).slice(0, 500)) {
    if (executed >= MAX_PER_RUN) break;
    const coin = getAddress(c.address);
    const quote = getAddress(c.quote);
    const [pending, leftover, last] = await Promise.all([
      ctx.client.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "destinationPendingFor", args: [coin, quote] }),
      ctx.client.readContract({ address: d.floorVault, abi: floorVaultAbi, functionName: "balanceOfFor", args: [coin, quote] }),
      ctx.client.readContract({ address: d.floorVault, abi: floorVaultAbi, functionName: "lastAddAtFor", args: [coin, quote] }),
    ]);
    if (quoteValueUsdE8(pending + leftover, c.decimals, BigInt(c.price_usd_e_8)) < ctx.thresholds.floorMinUsdE8) continue;
    if (last !== 0n && BigInt(now) < last + BigInt(FLOOR_COOLDOWN)) continue;

    const outcome = await simulateAndSend<readonly [number, number, bigint, bigint]>(ctx, ctx.wallets.keeper, {
      address: d.floorVault,
      abi: floorVaultAbi,
      functionName: "addFloorFor",
      args: [coin, quote],
    });
    if (outcome.kind === "no_wallet") {
      ctx.log("floor.no_wallet", { coin });
      return { executed, skipped };
    }
    if (outcome.kind === "reverted") {
      skipped += 1;
      const expected = ["CoolingDown", "NothingToAdd", "BandOutOfRange"].includes(outcome.error);
      await ctx.app.logKeeperRun({ job: "floor", target: c.pool_id, status: expected ? "skipped" : "failed", detail: { reason: outcome.error } });
      ctx.log("floor.skipped", { coin, reason: outcome.error });
      continue;
    }
    const [tickLower, tickUpper, , used] = outcome.result;
    executed += 1;
    await ctx.app.logKeeperRun({
      job: "floor",
      target: c.pool_id,
      status: outcome.kind === "sent" ? "ok" : "dry_run",
      detail: { tickLower, tickUpper, used },
      txHash: outcome.kind === "sent" ? outcome.hash : null,
    });
    ctx.log("floor.done", { coin, used, tickLower, tickUpper, tx: outcome.kind === "sent" ? outcome.hash : "dry-run" });
  }
  return { executed, skipped };
}

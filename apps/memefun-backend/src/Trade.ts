import { ponder } from "ponder:registry";
import { coin, quote, trade } from "ponder:schema";
import { zeroAddress } from "viem";

import { attributeTrade, lc } from "../lib/indexer/addresses";
import { addresses } from "../lib/indexer/runtime";
import { type RawTrade, applyTrade } from "./_apply";

ponder.on("MemeFunHook:Trade", async ({ event, context }) => {
  const args = event.args;
  const db = context.db;
  const c = await db.find(coin, { address: lc(args.coin) });
  if (!c) throw new Error(`Trade on unknown coin ${args.coin}`);
  const q = await db.find(quote, { address: lc(c.quote) });
  if (!q) throw new Error(`Trade on ${args.coin}: quote ${c.quote} is not listed`);

  const { trader, kind } = attributeTrade(addresses, {
    sender: args.trader,
    launcher: c.launcher,
    txFrom: event.transaction.from,
  });
  const raw: RawTrade = {
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    kind,
    trader,
    sender: lc(args.trader),
    isBuy: args.isBuy,
    quoteAmount: args.quoteAmount,
    coinAmount: args.coinAmount,
    fee: args.fee,
    feeBps: Number(args.feeBps),
    referrer: args.referrer === zeroAddress ? null : lc(args.referrer),
    sqrtPriceX96: args.sqrtPriceX96,
    tick: args.tick,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: Number(event.block.timestamp),
    txHash: event.transaction.hash,
  };

  if (!c.launched) {
    // The creator's first buy runs inside the launch, before `Launched` says what the coin opened
    // at. Park the raw trade; the Launched handler applies it with the opening state.
    if (kind !== "first_buy" || c.pendingFirstBuy) {
      throw new Error(`Unexpected ${kind} trade on ${args.coin} before its launch completed`);
    }
    await db.insert(trade).values({
      id: raw.id,
      coin: lc(c.address),
      trader: raw.trader,
      sender: raw.sender,
      isBuy: raw.isBuy,
      kind: raw.kind,
      quoteAmount: raw.quoteAmount,
      poolQuoteDelta: 0n,
      coinAmount: raw.coinAmount,
      fee: raw.fee,
      feeBps: raw.feeBps,
      referrer: raw.referrer,
      sqrtPriceX96: raw.sqrtPriceX96,
      tick: raw.tick,
      quoteUsdE8: 0n,
      valueUsdE8: 0n,
      priceUsdE18: 0n,
      marketCapUsdE8: 0n,
      inProtection: false,
      isCreator: true,
      blockNumber: raw.blockNumber,
      logIndex: raw.logIndex,
      timestamp: raw.timestamp,
      txHash: raw.txHash,
    });
    await db.update(coin, { address: lc(c.address) }).set({ pendingFirstBuy: raw.id });
    return;
  }

  await applyTrade(context, c, q, raw, q.priceUsdE8, { existingRow: false });
});

ponder.on("MemeFunHook:FeeLowered", async ({ event, context }) => {
  await context.db.update(coin, { address: lc(event.args.coin) }).set({ feeBps: Number(event.args.newFeeBps) });
});

ponder.on("MemeFunHook:CreatorTransferred", async ({ event, context }) => {
  await context.db.update(coin, { address: lc(event.args.coin) }).set({ creator: lc(event.args.next) });
});

import { and, eq } from "ponder";
import { type Context, ponder } from "ponder:registry";
import { authorLedger, authorSettlement, market, tweetAttribution } from "ponder:schema";
import type { Hex } from "viem";
import { lc } from "../lib/indexer/addresses";

ponder.on("FeeVault:TweetAttributed", async ({ event, context }) => {
  const { coin, postId, authorXUserId, authorShareBps, verifyBy } = event.args;
  await context.db.insert(tweetAttribution).values({ coin: lc(coin), postId, authorXUserId,
    authorShareBps: Number(authorShareBps), verifyBy: Number(verifyBy), verifiedWallet: null, verifiedAt: null });
});

ponder.on("FeeVault:AuthorVerified", async ({ event, context }) => {
  const attribution = await context.db.find(tweetAttribution, { coin: lc(event.args.coin) });
  if (!attribution || attribution.authorXUserId !== event.args.authorXUserId) throw new Error(`Author verification without matching tweet attribution ${event.args.coin}`);
  await context.db.update(tweetAttribution, { coin: lc(event.args.coin) }).set({ verifiedWallet: lc(event.args.wallet), verifiedAt: Number(event.block.timestamp) });
});

async function settlement(context: Context, event: { transaction: { hash: Hex }; log: { logIndex: number }; block: { timestamp: bigint } },
  args: { coin: Hex; quote: Hex; authorXUserId: bigint; to: Hex; amount: bigint }, kind: "claim" | "reclaim") {
  const attribution = await context.db.find(tweetAttribution, { coin: lc(args.coin) });
  if (!attribution || attribution.authorXUserId !== args.authorXUserId) throw new Error(`Author settlement without matching attribution ${args.coin}`);
  const [m] = await context.db.sql.select().from(market).where(and(eq(market.address, lc(args.coin)), eq(market.quote, lc(args.quote))));
  if (!m) throw new Error(`Author settlement on unknown market ${args.coin}/${args.quote}`);
  const ledger = await context.db.find(authorLedger, { poolId: m.poolId });
  const pending = ledger ? ledger.earned - ledger.claimed - ledger.reclaimed : 0n;
  if (args.amount > pending) throw new Error(`Author settlement ${args.amount} exceeds indexed reserve ${pending} for ${m.poolId}`);
  if (ledger) await context.db.update(authorLedger, { poolId: m.poolId }).set((row) => kind === "claim"
    ? { claimed: row.claimed + args.amount } : { reclaimed: row.reclaimed + args.amount });
  await context.db.insert(authorSettlement).values({ id: `${event.transaction.hash}-${event.log.logIndex}`, coin: lc(args.coin),
    poolId: m.poolId, quote: lc(args.quote), authorXUserId: args.authorXUserId, kind, to: lc(args.to), amount: args.amount,
    timestamp: Number(event.block.timestamp), txHash: event.transaction.hash });
}
ponder.on("FeeVault:AuthorClaimed", async ({ event, context }) => {
  await settlement(context, event, event.args, "claim");
});
ponder.on("FeeVault:AuthorRewardsReclaimed", async ({ event, context }) => {
  await settlement(context, event, { ...event.args, to: event.args.treasury }, "reclaim");
});

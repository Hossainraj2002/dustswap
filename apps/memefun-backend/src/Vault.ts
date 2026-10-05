import { and, eq } from "ponder";
import { ponder } from "ponder:registry";
import { coin, creatorClaim, market, platformLedger, referralLedger } from "ponder:schema";

import { lc } from "../lib/indexer/addresses";

/** FeeVault: credits are derived from each Trade (see src/_apply.ts); claims and pulls are here. */

ponder.on("FeeVault:CreatorClaimed", async ({ event, context }) => {
  const { coin: coinAddress, creator, to, currency, amount } = event.args;
  const [m] = await context.db.sql.select().from(market).where(and(eq(market.address, lc(coinAddress)), eq(market.quote, lc(currency))));
  if (!m) throw new Error(`Claim on unknown market ${coinAddress}/${currency}`);
  await context.db.update(market, { poolId: m.poolId }).set((row) => ({ creatorClaimed: row.creatorClaimed + amount }));
  const c = await context.db.find(coin, { address: lc(coinAddress) });
  if (c?.poolId === m.poolId) await context.db.update(coin, { address: lc(coinAddress) }).set((row) => ({ creatorClaimed: row.creatorClaimed + amount }));
  await context.db.insert(creatorClaim).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    coin: lc(coinAddress),
    poolId: m.poolId,
    quote: lc(currency),
    creator: lc(creator),
    to: lc(to),
    amount,
    timestamp: Number(event.block.timestamp),
    txHash: event.transaction.hash,
  });
});

ponder.on("FeeVault:ReferralClaimed", async ({ event, context }) => {
  const { referrer, currency, amount } = event.args;
  await context.db
    .insert(referralLedger)
    .values({ referrer: lc(referrer), currency: lc(currency), earned: 0n, claimed: amount, trades: 0 })
    .onConflictDoUpdate((row) => ({ claimed: row.claimed + amount }));
});

ponder.on("FeeVault:PlatformClaimed", async ({ event, context }) => {
  const { currency, amount } = event.args;
  await context.db
    .insert(platformLedger)
    .values({ currency: lc(currency), earned: 0n, claimed: amount })
    .onConflictDoUpdate((row) => ({ claimed: row.claimed + amount }));
});

ponder.on("FeeVault:DestinationPulled", async ({ event, context }) => {
  const { coin: coinAddress, amount } = event.args;
  const c = await context.db.find(coin, { address: lc(coinAddress) });
  const m = c ? await context.db.find(market, { poolId: c.poolId }) : null;
  if (!m || m.hasMarketEvents) return;
  await context.db.update(market, { poolId: m.poolId }).set((row) => ({ destinationPulled: row.destinationPulled + amount }));
  await context.db.update(coin, { address: lc(coinAddress) }).set((c) => ({ destinationPulled: c.destinationPulled + amount }));
});

ponder.on("FeeVault:MarketDestinationPulled", async ({ event, context }) => {
  const { coin: coinAddress, poolId, amount } = event.args;
  await context.db.update(market, { poolId }).set((row) => ({ destinationPulled: row.destinationPulled + amount }));
  const c = await context.db.find(coin, { address: lc(coinAddress) });
  if (c?.poolId === poolId) await context.db.update(coin, { address: lc(coinAddress) }).set((row) => ({ destinationPulled: row.destinationPulled + amount }));
});

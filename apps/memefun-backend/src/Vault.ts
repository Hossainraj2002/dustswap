import { ponder } from "ponder:registry";
import { coin, creatorClaim, platformLedger, referralLedger } from "ponder:schema";

import { lc } from "../lib/indexer/addresses";

/** FeeVault: credits are derived from each Trade (see src/_apply.ts); claims and pulls are here. */

ponder.on("FeeVault:CreatorClaimed", async ({ event, context }) => {
  const { coin: coinAddress, creator, to, amount } = event.args;
  await context.db.update(coin, { address: lc(coinAddress) }).set((c) => ({ creatorClaimed: c.creatorClaimed + amount }));
  await context.db.insert(creatorClaim).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    coin: lc(coinAddress),
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
  await context.db.update(coin, { address: lc(coinAddress) }).set((c) => ({ destinationPulled: c.destinationPulled + amount }));
});

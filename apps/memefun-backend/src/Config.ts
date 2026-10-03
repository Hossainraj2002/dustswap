import { type Context, ponder } from "ponder:registry";
import { quote, quotePrice, settingChange } from "ponder:schema";
import { type Address, type Hex, erc20Abi, hexToString, zeroAddress } from "viem";

import { aggregatorV3Abi } from "../lib/abi-extra";
import { lc } from "../lib/indexer/addresses";
import { deployment } from "../lib/indexer/runtime";

const PRICE_SOURCE = { fixed: 0, chainlink: 1, manual: 2 } as const;

/** bytes32 setting and role keys are short ASCII names ("creationFee", "priceKeeper"). */
function keyName(key: Hex): string {
  try {
    return hexToString(key, { size: 32 }).replace(/\0+$/, "");
  } catch {
    return key;
  }
}

async function readFeed(context: Context, feed: Address): Promise<{ priceUsdE8: bigint; updatedAt: number } | null> {
  try {
    const [, answer, , updatedAt] = await context.client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" });
    return answer > 0n ? { priceUsdE8: answer, updatedAt: Number(updatedAt) } : null;
  } catch {
    return null;
  }
}

async function tokenLabel(context: Context, token: Address): Promise<{ symbol: string; name: string }> {
  if (token === zeroAddress) return { symbol: "ETH", name: "Ether" };
  const [symbol, name] = await Promise.all([
    context.client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    context.client.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => "Unknown token"),
  ]);
  return { symbol, name };
}

async function recordPrice(
  context: Context,
  input: { quote: string; priceUsdE8: bigint; source: string; blockNumber: bigint; timestamp: number; suffix?: string },
) {
  await context.db
    .insert(quotePrice)
    .values({
      id: `${lc(input.quote)}-${input.blockNumber}-${input.suffix ?? input.source}`,
      quote: lc(input.quote),
      priceUsdE8: input.priceUsdE8,
      source: input.source,
      blockNumber: input.blockNumber,
      timestamp: input.timestamp,
    })
    .onConflictDoNothing();
}

async function logChange(
  context: Context,
  event: { block: { number: bigint; timestamp: bigint }; log: { logIndex: number }; transaction: { hash: Hex } },
  change: { kind: string; key: string; oldValue?: string | null; newValue?: string | null; detail?: unknown },
) {
  await context.db.insert(settingChange).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    kind: change.kind,
    key: change.key,
    oldValue: change.oldValue ?? null,
    newValue: change.newValue ?? null,
    detail: change.detail ?? null,
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
    txHash: event.transaction.hash,
  });
}

ponder.on("MemeFunConfig:QuoteListed", async ({ event, context }) => {
  const args = event.args;
  const timestamp = Number(event.block.timestamp);
  const label = await tokenLabel(context, args.quote);
  let priceUsdE8 = args.priceUsdE8;
  let priceUpdatedAt = timestamp;
  if (args.source === PRICE_SOURCE.chainlink) {
    const read = await readFeed(context, args.feed);
    priceUsdE8 = read?.priceUsdE8 ?? 0n;
    priceUpdatedAt = read?.updatedAt ?? 0;
  }
  await context.db.insert(quote).values({
    address: lc(args.quote),
    kind: args.kind,
    decimals: args.decimals,
    symbol: label.symbol,
    name: label.name,
    source: args.source,
    feed: args.source === PRICE_SOURCE.chainlink ? lc(args.feed) : null,
    maxAge: args.maxAge,
    enabled: false,
    priceUsdE8,
    priceUpdatedAt,
    listedAt: timestamp,
  });
  if (priceUsdE8 > 0n) {
    await recordPrice(context, { quote: args.quote, priceUsdE8, source: "listed", blockNumber: event.block.number, timestamp });
  }
  await logChange(context, event, {
    kind: "quote_listed",
    key: lc(args.quote),
    newValue: label.symbol,
    detail: { kind: args.kind, decimals: args.decimals, source: args.source, feed: args.feed, priceUsdE8: args.priceUsdE8.toString(), maxAge: args.maxAge },
  });
});

ponder.on("MemeFunConfig:QuotePricingUpdated", async ({ event, context }) => {
  const args = event.args;
  const timestamp = Number(event.block.timestamp);
  let priceUsdE8 = args.priceUsdE8;
  let priceUpdatedAt = timestamp;
  if (args.source === PRICE_SOURCE.chainlink) {
    const read = await readFeed(context, args.feed);
    priceUsdE8 = read?.priceUsdE8 ?? 0n;
    priceUpdatedAt = read?.updatedAt ?? 0;
  }
  await context.db.update(quote, { address: lc(args.quote) }).set({
    source: args.source,
    feed: args.source === PRICE_SOURCE.chainlink ? lc(args.feed) : null,
    maxAge: args.maxAge,
    ...(priceUsdE8 > 0n ? { priceUsdE8, priceUpdatedAt } : {}),
  });
  if (priceUsdE8 > 0n) {
    await recordPrice(context, { quote: args.quote, priceUsdE8, source: "pricing", blockNumber: event.block.number, timestamp });
  }
  await logChange(context, event, {
    kind: "quote_pricing",
    key: lc(args.quote),
    detail: { source: args.source, feed: args.feed, priceUsdE8: args.priceUsdE8.toString(), maxAge: args.maxAge },
  });
});

ponder.on("MemeFunConfig:QuoteEnabled", async ({ event, context }) => {
  await context.db.update(quote, { address: lc(event.args.quote) }).set({ enabled: event.args.enabled });
  await logChange(context, event, { kind: "quote_enabled", key: lc(event.args.quote), newValue: String(event.args.enabled) });
});

ponder.on("MemeFunConfig:QuotePriceSet", async ({ event, context }) => {
  const args = event.args;
  const timestamp = Number(event.block.timestamp);
  await context.db.update(quote, { address: lc(args.quote) }).set({ priceUsdE8: args.newPriceUsdE8, priceUpdatedAt: timestamp });
  await recordPrice(context, {
    quote: args.quote,
    priceUsdE8: args.newPriceUsdE8,
    source: lc(args.setter) === lc(deployment.owner) ? "owner" : "keeper",
    blockNumber: event.block.number,
    timestamp,
    suffix: `set-${event.log.logIndex}`,
  });
  await logChange(context, event, {
    kind: "quote_price",
    key: lc(args.quote),
    oldValue: args.oldPriceUsdE8.toString(),
    newValue: args.newPriceUsdE8.toString(),
    detail: { setter: lc(args.setter) },
  });
});

ponder.on("MemeFunConfig:QuoteKindEnabled", async ({ event, context }) => {
  await logChange(context, event, { kind: "quote_kind", key: String(event.args.kind), newValue: String(event.args.enabled) });
});

ponder.on("MemeFunConfig:ModeUpdated", async ({ event, context }) => {
  await logChange(context, event, {
    kind: "mode",
    key: String(event.args.mode),
    newValue: String(event.args.enabled),
    detail: { module: lc(event.args.module) },
  });
});

ponder.on("MemeFunConfig:SettingUpdated", async ({ event, context }) => {
  await logChange(context, event, {
    kind: "setting",
    key: keyName(event.args.key),
    oldValue: event.args.oldValue.toString(),
    newValue: event.args.newValue.toString(),
  });
});

ponder.on("MemeFunConfig:RoleUpdated", async ({ event, context }) => {
  await logChange(context, event, {
    kind: "role",
    key: keyName(event.args.role),
    oldValue: lc(event.args.oldAccount),
    newValue: lc(event.args.newAccount),
  });
});

ponder.on("MemeFunConfig:OwnershipTransferStarted", async ({ event, context }) => {
  await logChange(context, event, { kind: "owner_pending", key: "owner", oldValue: lc(event.args.previousOwner), newValue: lc(event.args.newOwner) });
});

ponder.on("MemeFunConfig:OwnershipTransferred", async ({ event, context }) => {
  await logChange(context, event, { kind: "owner", key: "owner", oldValue: lc(event.args.previousOwner), newValue: lc(event.args.newOwner) });
});

/** Chainlink ETH/USD every few minutes, so trades are valued with a recent ETH price. */
ponder.on("EthUsdPrice:block", async ({ event, context }) => {
  const eth = await context.db.find(quote, { address: lc(zeroAddress) });
  if (!eth || eth.source !== PRICE_SOURCE.chainlink || !eth.feed) return;
  const read = await readFeed(context, eth.feed as Address);
  if (!read || read.updatedAt <= eth.priceUpdatedAt) return;
  await context.db.update(quote, { address: lc(zeroAddress) }).set({ priceUsdE8: read.priceUsdE8, priceUpdatedAt: read.updatedAt });
  await recordPrice(context, {
    quote: zeroAddress,
    priceUsdE8: read.priceUsdE8,
    source: "chainlink",
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
  });
});

import { index, onchainTable, primaryKey } from "ponder";

/**
 * Everything memefun's contracts say, as tables. Token amounts are raw integers (Postgres
 * NUMERIC via `bigint`), never floats. USD values carry their scale in the name: `UsdE8` is
 * USD with 8 decimals (Chainlink scale), `UsdE18` is USD with 18 decimals (coin prices, which are
 * tiny). Every row is written by an indexing function in src/; nothing else writes here.
 */

/** Pair assets listed in MemeFunConfig: ETH, USDC and tokenized stocks. */
export const quote = onchainTable("quote", (t) => ({
  address: t.hex().primaryKey(),
  /** 0 native, 1 stable, 2 stock (MemeFunTypes.QuoteKind). */
  kind: t.integer().notNull(),
  decimals: t.integer().notNull(),
  symbol: t.text().notNull(),
  name: t.text().notNull(),
  /** 0 fixed, 1 chainlink, 2 manual (MemeFunTypes.PriceSource). */
  source: t.integer().notNull(),
  feed: t.hex(),
  maxAge: t.integer().notNull(),
  enabled: t.boolean().notNull(),
  priceUsdE8: t.bigint().notNull(),
  priceUpdatedAt: t.integer().notNull(),
  listedAt: t.integer().notNull(),
}));

/** USD price history of each pair asset: Chainlink samples, keeper NAV updates, launches. */
export const quotePrice = onchainTable(
  "quote_price",
  (t) => ({
    id: t.text().primaryKey(),
    quote: t.hex().notNull(),
    priceUsdE8: t.bigint().notNull(),
    source: t.text().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({ quoteTimeIdx: index().on(table.quote, table.timestamp) }),
);

export const coin = onchainTable(
  "coin",
  (t) => ({
    address: t.hex().primaryKey(),
    poolId: t.hex().notNull(),
    /** Earns creator fees and may lower the fee; changes through a two-step transfer. */
    creator: t.hex().notNull(),
    /** Who launched the coin (never changes). */
    launcher: t.hex().notNull(),
    quote: t.hex().notNull(),
    quoteIsCurrency0: t.boolean().notNull(),
    /** 0 creator, 1 burn, 2 holders, 3 floor (MemeFunTypes.Mode). */
    mode: t.integer().notNull(),
    module: t.hex().notNull(),
    feeBps: t.integer().notNull(),
    launchFeeBps: t.integer().notNull(),
    platformShareBps: t.integer().notNull(),
    referralShareBps: t.integer().notNull(),
    creatorKeepBps: t.integer().notNull(),
    protectionStartBps: t.integer().notNull(),
    protectionDurationSec: t.integer().notNull(),
    createdAt: t.integer().notNull(),
    createdBlock: t.bigint().notNull(),

    // From `Launched`, emitted at the end of the launch transaction.
    launched: t.boolean().notNull(),
    name: t.text().notNull(),
    symbol: t.text().notNull(),
    contractUri: t.text().notNull(),
    startTick: t.integer().notNull(),
    liquidity: t.bigint().notNull(),
    launchQuoteUsdE8: t.bigint().notNull(),
    openingFdvUsdE8: t.bigint().notNull(),
    launchTx: t.hex(),
    /** The first buy's Trade arrives before `Launched`; it is applied once the coin is complete. */
    pendingFirstBuy: t.text(),

    // Pool state.
    sqrtPriceX96: t.bigint().notNull(),
    tick: t.integer().notNull(),
    /** Quote held by the pool across all its positions (launch position and floor bands). */
    poolQuote: t.bigint().notNull(),
    /** Coins held by the PoolManager for this pool. */
    poolCoins: t.bigint().notNull(),
    /** Coins at dEaD: launch dust, buybacks, and anything else sent there. */
    burned: t.bigint().notNull(),

    // Market.
    priceUsdE18: t.bigint().notNull(),
    marketCapUsdE8: t.bigint().notNull(),
    athMarketCapUsdE8: t.bigint().notNull(),
    volumeQuote: t.bigint().notNull(),
    volumeUsdE8: t.bigint().notNull(),
    trades: t.integer().notNull(),
    buys: t.integer().notNull(),
    sells: t.integer().notNull(),
    lastTradeAt: t.integer().notNull(),
    holders: t.integer().notNull(),

    // Fee ledgers, in quote units (FeeVault credits are derived from Trade with the same split).
    feesTotal: t.bigint().notNull(),
    platformFees: t.bigint().notNull(),
    referralFees: t.bigint().notNull(),
    creatorEarned: t.bigint().notNull(),
    creatorClaimed: t.bigint().notNull(),
    destinationEarned: t.bigint().notNull(),
    destinationPulled: t.bigint().notNull(),

    // Fee destinations.
    buybacks: t.integer().notNull(),
    buybackSpent: t.bigint().notNull(),
    buybackBurned: t.bigint().notNull(),
    floorAdds: t.integer().notNull(),
    floorQuote: t.bigint().notNull(),
    floorNearTick: t.integer(),
    holdersReserved: t.bigint().notNull(),
    holdersClaimed: t.bigint().notNull(),
    holdersReturned: t.bigint().notNull(),
    epochs: t.integer().notNull(),

    // Launch fairness signals.
    devSold: t.boolean().notNull(),
    snipers: t.integer().notNull(),
    sameBlockBuys: t.integer().notNull(),
  }),
  (table) => ({
    creatorIdx: index().on(table.creator),
    launcherIdx: index().on(table.launcher),
    createdIdx: index().on(table.createdAt),
    mcapIdx: index().on(table.marketCapUsdE8),
    lastTradeIdx: index().on(table.lastTradeAt),
  }),
);

/** One row per swap on a memefun pool (the hook's Trade event), from the trader's side. */
export const trade = onchainTable(
  "trade",
  (t) => ({
    id: t.text().primaryKey(),
    coin: t.hex().notNull(),
    /** Who traded: the MemeFunRouter user, the creator for a first buy, the tx sender for known routers. */
    trader: t.hex().notNull(),
    /** The hook's `trader` field as emitted. */
    sender: t.hex().notNull(),
    isBuy: t.boolean().notNull(),
    /** "trade", "first_buy" or "buyback". */
    kind: t.text().notNull(),
    /** Paid by a buyer (fee included) or received by a seller (fee taken). */
    quoteAmount: t.bigint().notNull(),
    /** Signed change of the quote held by the pool. */
    poolQuoteDelta: t.bigint().notNull(),
    coinAmount: t.bigint().notNull(),
    fee: t.bigint().notNull(),
    feeBps: t.integer().notNull(),
    referrer: t.hex(),
    sqrtPriceX96: t.bigint().notNull(),
    tick: t.integer().notNull(),
    quoteUsdE8: t.bigint().notNull(),
    valueUsdE8: t.bigint().notNull(),
    priceUsdE18: t.bigint().notNull(),
    marketCapUsdE8: t.bigint().notNull(),
    inProtection: t.boolean().notNull(),
    isCreator: t.boolean().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    coinOrderIdx: index().on(table.coin, table.blockNumber, table.logIndex),
    traderIdx: index().on(table.trader, table.timestamp),
    timeIdx: index().on(table.timestamp),
    orderIdx: index().on(table.blockNumber, table.logIndex),
  }),
);

/** Raw coin transfers, the source of holder balances and holder-reward epochs. */
export const transfer = onchainTable(
  "transfer",
  (t) => ({
    id: t.text().primaryKey(),
    coin: t.hex().notNull(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    coinOrderIdx: index().on(table.coin, table.blockNumber, table.logIndex),
    coinTimeIdx: index().on(table.coin, table.timestamp),
  }),
);

export const balance = onchainTable(
  "balance",
  (t) => ({
    coin: t.hex().notNull(),
    account: t.hex().notNull(),
    amount: t.bigint().notNull(),
    /** PoolManager, dEaD, the zero address and every memefun contract: never counted as holders. */
    excluded: t.boolean().notNull(),
    /** From this account's own trades: coins bought and their USD cost (average-cost P&L). */
    boughtCoins: t.bigint().notNull(),
    boughtUsdE8: t.bigint().notNull(),
    soldCoins: t.bigint().notNull(),
    soldUsdE8: t.bigint().notNull(),
    firstHeldAt: t.integer(),
    updatedAt: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.coin, table.account] }),
    coinAmountIdx: index().on(table.coin, table.amount),
    accountIdx: index().on(table.account),
  }),
);

/** OHLCV per coin and interval (60, 300, 900, 3600, 14400, 86400 s), in USD. */
export const candle = onchainTable(
  "candle",
  (t) => ({
    coin: t.hex().notNull(),
    interval: t.integer().notNull(),
    bucket: t.integer().notNull(),
    openUsdE18: t.bigint().notNull(),
    highUsdE18: t.bigint().notNull(),
    lowUsdE18: t.bigint().notNull(),
    closeUsdE18: t.bigint().notNull(),
    openMcapUsdE8: t.bigint().notNull(),
    highMcapUsdE8: t.bigint().notNull(),
    lowMcapUsdE8: t.bigint().notNull(),
    closeMcapUsdE8: t.bigint().notNull(),
    volumeUsdE8: t.bigint().notNull(),
    volumeQuote: t.bigint().notNull(),
    trades: t.integer().notNull(),
    buys: t.integer().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.coin, table.interval, table.bucket] }) }),
);

/** FeeVault referral ledger: per referrer and pair asset, as the vault keeps it. */
export const referralLedger = onchainTable(
  "referral_ledger",
  (t) => ({
    referrer: t.hex().notNull(),
    currency: t.hex().notNull(),
    earned: t.bigint().notNull(),
    claimed: t.bigint().notNull(),
    trades: t.integer().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.referrer, table.currency] }) }),
);

export const platformLedger = onchainTable("platform_ledger", (t) => ({
  currency: t.hex().primaryKey(),
  earned: t.bigint().notNull(),
  claimed: t.bigint().notNull(),
}));

export const creatorClaim = onchainTable(
  "creator_claim",
  (t) => ({
    id: t.text().primaryKey(),
    coin: t.hex().notNull(),
    creator: t.hex().notNull(),
    to: t.hex().notNull(),
    amount: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ coinIdx: index().on(table.coin), creatorIdx: index().on(table.creator) }),
);

export const buyback = onchainTable(
  "buyback",
  (t) => ({
    id: t.text().primaryKey(),
    coin: t.hex().notNull(),
    quoteSpent: t.bigint().notNull(),
    coinsBurned: t.bigint().notNull(),
    quoteLeft: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ coinIdx: index().on(table.coin, table.timestamp) }),
);

export const floorAdd = onchainTable(
  "floor_add",
  (t) => ({
    id: t.text().primaryKey(),
    coin: t.hex().notNull(),
    tickLower: t.integer().notNull(),
    tickUpper: t.integer().notNull(),
    liquidity: t.bigint().notNull(),
    quoteUsed: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ coinIdx: index().on(table.coin, table.timestamp) }),
);

/** Holder-reward epochs published to HolderRewardDistributor. */
export const epoch = onchainTable("epoch", (t) => ({
  epoch: t.bigint().primaryKey(),
  root: t.hex().notNull(),
  publishedAt: t.integer().notNull(),
  vetoed: t.boolean().notNull(),
  coins: t.integer().notNull(),
  blockNumber: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

export const epochCoin = onchainTable(
  "epoch_coin",
  (t) => ({
    epoch: t.bigint().notNull(),
    coin: t.hex().notNull(),
    total: t.bigint().notNull(),
    claimed: t.bigint().notNull(),
    claims: t.integer().notNull(),
    released: t.boolean().notNull(),
    returned: t.bigint().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.epoch, table.coin] }), coinIdx: index().on(table.coin) }),
);

export const holderClaim = onchainTable(
  "holder_claim",
  (t) => ({
    id: t.text().primaryKey(),
    epoch: t.bigint().notNull(),
    coin: t.hex().notNull(),
    index: t.bigint().notNull(),
    account: t.hex().notNull(),
    amount: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    accountIdx: index().on(table.account),
    epochCoinIdx: index().on(table.epoch, table.coin),
  }),
);

/** Every owner-side change in MemeFunConfig, for the admin page's history. */
export const settingChange = onchainTable(
  "setting_change",
  (t) => ({
    id: t.text().primaryKey(),
    kind: t.text().notNull(),
    key: t.text().notNull(),
    oldValue: t.text(),
    newValue: t.text(),
    detail: t.json(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ timeIdx: index().on(table.timestamp) }),
);

/** First crossing of each market-cap milestone, per coin. */
export const milestone = onchainTable(
  "milestone",
  (t) => ({
    coin: t.hex().notNull(),
    levelUsd: t.integer().notNull(),
    tradeId: t.text().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.coin, table.levelUsd] }) }),
);

/** The tape's non-trade items: launches, buybacks, floor adds, payouts and milestones. */
export const activity = onchainTable(
  "activity",
  (t) => ({
    id: t.text().primaryKey(),
    kind: t.text().notNull(),
    coin: t.hex().notNull(),
    amountQuote: t.bigint(),
    amountCoins: t.bigint(),
    milestoneUsd: t.integer(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    orderIdx: index().on(table.blockNumber, table.logIndex),
    coinIdx: index().on(table.coin, table.timestamp),
  }),
);

/** Wallets that bought during launch protection (not the creator's first buy). */
export const sniper = onchainTable(
  "sniper",
  (t) => ({
    coin: t.hex().notNull(),
    trader: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.coin, table.trader] }) }),
);

/** Distinct buyers per block in a coin's first minute, for the same-block-buys signal. */
export const launchBlockBuyer = onchainTable(
  "launch_block_buyer",
  (t) => ({
    coin: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    trader: t.hex().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.coin, table.blockNumber, table.trader] }) }),
);

export const launchBlock = onchainTable(
  "launch_block",
  (t) => ({
    coin: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    buyers: t.integer().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.coin, table.blockNumber] }) }),
);

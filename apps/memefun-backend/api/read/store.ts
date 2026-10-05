import { type Queryable, big, rows } from "../../lib/db";
import type { CandleRecord, CoinRecord, MarketRecord, QuoteRecord, TradeRecord } from "../../lib/market/derive";
import type { TweetAttribution } from "../../shared/core/tweet";
import { getAddress } from "viem";

/**
 * Every query the read API makes. `index` is the read-only pool on Ponder's schema; `app` is the
 * memefun_app pool. Column names are Ponder's snake_case (digits split: `price_usd_e_18`).
 * Addresses are stored lowercase, so callers pass lowercase.
 */
export interface ReadStore {
  latestTimestamp(): Promise<number>;
  quotes(): Promise<QuoteRecord[]>;
  coins(): Promise<CoinRecord[]>;
  markets?(): Promise<MarketRecord[]>;
  tweetAttributions?(): Promise<Map<string, TweetAttribution>>;
  authorLedgerOf?(wallet: string): Promise<Array<{ coin: string; poolId: string; quote: string; earned: bigint; claimed: bigint; reclaimed: bigint }>>;
  marketWindows?(poolIds: string[], nowSec: number): Promise<Map<string, WindowAggregates>>;
  coinsWithTransfersSince(block: bigint): Promise<{ coins: string[]; maxBlock: bigint }>;
  holderStats(coins: string[], creators: Map<string, string>): Promise<Map<string, { top10: bigint; creatorBalance: bigint }>>;
  windows(coins: string[], nowSec: number): Promise<Map<string, WindowAggregates>>;
  sparklineCloses(coins: string[], fromSec: number): Promise<Map<string, Array<{ bucket: number; close: bigint }>>>;
  trades(coin: string, options: { limit: number; before?: TradeCursor; poolId?: string }): Promise<StoredTrade[]>;
  tradesByTrader(trader: string, limit: number): Promise<StoredTrade[]>;
  tradesAfter(cursor: TradeCursor, limit: number): Promise<StoredTrade[]>;
  recentTrades(limit: number): Promise<StoredTrade[]>;
  candles(coin: string, interval: number, fromBucket: number, metric: "price" | "mcap", poolId?: string): Promise<CandleRecord[]>;
  lastCloseBefore(coin: string, interval: number, bucket: number, metric: "price" | "mcap", poolId?: string): Promise<bigint | null>;
  holders(coin: string, limit: number): Promise<Array<{ account: string; amount: bigint }>>;
  balance(coin: string, account: string): Promise<BalanceRecord | null>;
  balancesOf(account: string): Promise<BalanceRecord[]>;
  activity(options: { limit: number; after?: TradeCursor }): Promise<ActivityRecord[]>;
  referralLedger(referrer: string): Promise<Array<{ currency: string; earned: bigint; claimed: bigint }>>;
  holderClaimsOf(account: string): Promise<Set<string>>;
  epochs(): Promise<Map<string, { publishedAt: number; vetoed: boolean }>>;
  platformTotals(): Promise<{ trades: number; volumeUsdE8: bigint; coins: number }>;
  pool(coin: string, poolId?: string): Promise<PoolRecord | null>;
}

/** A coin's pool as the PoolManager holds it: slot0, the launch position and the floor bands. */
export interface PoolRecord {
  poolId: string;
  quote: string;
  quoteIsCurrency0: boolean;
  startTick: number;
  /** The launch position's liquidity. */
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  floors: Array<{ tickLower: number; tickUpper: number; liquidity: bigint }>;
}

/** A trade with its position in the chain, for cursors. */
export type StoredTrade = TradeRecord & TradeCursor;

export interface TradeCursor {
  blockNumber: bigint;
  logIndex: number;
}

export interface WindowAggregates {
  volume24hUsdE8: bigint;
  trades24h: number;
  buys24h: number;
  volume1hUsdE8: bigint;
  trades15m: number;
  priceAgo: { m5: bigint | null; h1: bigint | null; h24: bigint | null };
}

export interface BalanceRecord {
  coin: string;
  account: string;
  amount: bigint;
  boughtCoins: bigint;
  boughtUsdE8: bigint;
}

export interface ActivityRecord {
  id: string;
  kind: string;
  coin: string;
  poolId?: string | null;
  currency?: string | null;
  amountQuote: bigint | null;
  amountCoins: bigint | null;
  milestoneUsd: number | null;
  blockNumber: bigint;
  logIndex: number;
  timestamp: number;
}

type Row = Record<string, string | number | boolean | null>;

const num = (value: unknown) => Number(value ?? 0);
const opt = (value: unknown) => (value === null || value === undefined ? null : BigInt(value as string));

function coinRecord(r: Row): CoinRecord {
  return {
    address: String(r.address),
    poolId: String(r.pool_id),
    pendingCreator: r.pending_creator ? String(r.pending_creator) : null,
    creator: String(r.creator),
    launcher: String(r.launcher),
    quote: String(r.quote),
    quoteIsCurrency0: Boolean(r.quote_is_currency0),
    mode: num(r.mode),
    module: String(r.module),
    feeBps: num(r.fee_bps),
    platformShareBps: num(r.platform_share_bps),
    referralShareBps: num(r.referral_share_bps),
    creatorKeepBps: num(r.creator_keep_bps),
    protectionStartBps: num(r.protection_start_bps),
    protectionDurationSec: num(r.protection_duration_sec),
    createdAt: num(r.created_at),
    name: String(r.name),
    symbol: String(r.symbol),
    contractUri: String(r.contract_uri),
    startTick: num(r.start_tick),
    launchQuoteUsdE8: big(r.launch_quote_usd_e_8 as string),
    sqrtPriceX96: big(r.sqrt_price_x_96 as string),
    poolQuote: big(r.pool_quote as string),
    poolCoins: big(r.pool_coins as string),
    burned: big(r.burned as string),
    athMarketCapUsdE8: big(r.ath_market_cap_usd_e_8 as string),
    volumeUsdE8: big(r.volume_usd_e_8 as string),
    trades: num(r.trades),
    lastTradeAt: num(r.last_trade_at),
    holders: num(r.holders),
    feesTotal: big(r.fees_total as string),
    platformFees: big(r.platform_fees as string),
    referralFees: big(r.referral_fees as string),
    creatorEarned: big(r.creator_earned as string),
    creatorClaimed: big(r.creator_claimed as string),
    destinationEarned: big(r.destination_earned as string),
    buybacks: num(r.buybacks),
    buybackSpent: big(r.buyback_spent as string),
    buybackBurned: big(r.buyback_burned as string),
    floorQuote: big(r.floor_quote as string),
    floorNearTick: r.floor_near_tick === null ? null : num(r.floor_near_tick),
    holdersReserved: big(r.holders_reserved as string),
    holdersReturned: big(r.holders_returned as string),
    epochs: num(r.epochs),
    devSold: Boolean(r.dev_sold),
    snipers: num(r.snipers),
    sameBlockBuys: num(r.same_block_buys),
  };
}

function tradeRecord(r: Row): StoredTrade {
  return {
    id: String(r.id),
    coin: String(r.coin),
    poolId: r.pool_id ? String(r.pool_id) : undefined,
    quote: r.quote ? String(r.quote) : undefined,
    trader: String(r.trader),
    kind: String(r.kind),
    isBuy: Boolean(r.is_buy),
    quoteAmount: big(r.quote_amount as string),
    coinAmount: big(r.coin_amount as string),
    fee: big(r.fee as string),
    feeBps: num(r.fee_bps),
    priceUsdE18: big(r.price_usd_e_18 as string),
    marketCapUsdE8: big(r.market_cap_usd_e_8 as string),
    isCreator: Boolean(r.is_creator),
    inProtection: Boolean(r.in_protection),
    timestamp: num(r.timestamp),
    txHash: String(r.tx_hash) as `0x${string}`,
    blockNumber: big(r.block_number as string),
    logIndex: num(r.log_index),
  };
}

const TRADE_COLUMNS = `id, coin, pool_id, quote, trader, kind, is_buy, quote_amount, coin_amount, fee, fee_bps, price_usd_e_18,
  market_cap_usd_e_8, is_creator, in_protection, timestamp, tx_hash, block_number, log_index`;

export function createReadStore(index: Queryable): ReadStore {
  return {
    async latestTimestamp() {
      const [row] = await rows<Row>(index, `SELECT COALESCE(MAX(timestamp), 0) AS ts FROM trade`);
      const [launch] = await rows<Row>(index, `SELECT COALESCE(MAX(created_at), 0) AS ts FROM coin`);
      return Math.max(num(row?.ts), num(launch?.ts));
    },

    async quotes() {
      const result = await rows<Row>(index, `SELECT address, kind, decimals, symbol, name, price_usd_e_8, enabled, source, feed, max_age, price_updated_at FROM quote`);
      return result.map((r) => ({
        address: String(r.address),
        kind: num(r.kind),
        decimals: num(r.decimals),
        symbol: String(r.symbol),
        name: String(r.name),
        priceUsdE8: big(r.price_usd_e_8 as string),
        enabled: r.enabled === true,
        source: num(r.source),
        feed: r.feed ? String(r.feed) : null,
        maxAge: num(r.max_age),
        priceUpdatedAt: num(r.price_updated_at),
      }));
    },

    async coins() {
      return (await rows<Row>(index, `SELECT * FROM coin WHERE launched = true`)).map(coinRecord);
    },
    async markets() {
      return (await rows<Row>(index, `SELECT * FROM market WHERE launched = true`)).map((r) => ({
        ...coinRecord(r), poolId: String(r.pool_id), supplyRaw: big(r.supply_raw as string),
      }));
    },
    async tweetAttributions() {
      const result = await rows<Row>(index, `SELECT t.*, EXISTS (SELECT 1 FROM author_ledger a WHERE a.coin = t.coin AND a.reclaimed > 0) AS reclaimed
        FROM tweet_attribution t`);
      return new Map(result.map((r) => [String(r.coin), {
        postId: String(r.post_id), authorXUserId: String(r.author_x_user_id), authorShareBps: num(r.author_share_bps), verifyBy: num(r.verify_by) * 1_000,
        treasuryUnlockAt: num(r.verify_by) * 1_000,
        ...(r.verified_wallet ? { authorWallet: getAddress(String(r.verified_wallet)) } : {}), reclaimed: Boolean(r.reclaimed),
      }]));
    },
    async authorLedgerOf(wallet) {
      const result = await rows<Row>(index, `SELECT a.* FROM author_ledger a JOIN tweet_attribution t ON t.coin = a.coin
        WHERE t.verified_wallet = $1 AND a.earned > a.claimed + a.reclaimed`, [wallet]);
      return result.map((r) => ({ coin: String(r.coin), poolId: String(r.pool_id), quote: String(r.quote),
        earned: big(r.earned as string), claimed: big(r.claimed as string), reclaimed: big(r.reclaimed as string) }));
    },

    async coinsWithTransfersSince(block) {
      const result = await rows<Row>(
        index,
        `SELECT coin, MAX(block_number) AS max_block FROM transfer WHERE block_number > $1 GROUP BY coin`,
        [block.toString()],
      );
      let maxBlock = block;
      for (const r of result) if (big(r.max_block as string) > maxBlock) maxBlock = big(r.max_block as string);
      return { coins: result.map((r) => String(r.coin)), maxBlock };
    },

    async holderStats(coins, creators) {
      const out = new Map<string, { top10: bigint; creatorBalance: bigint }>();
      if (coins.length === 0) return out;
      const top = await rows<Row>(
        index,
        `SELECT c.coin, COALESCE(SUM(t.amount), 0) AS top10
           FROM UNNEST($1::text[]) AS c(coin)
           LEFT JOIN LATERAL (
             SELECT amount FROM balance b
              WHERE b.coin = c.coin AND b.excluded = false AND b.amount > 0
              ORDER BY b.amount DESC LIMIT 10
           ) t ON true
          GROUP BY c.coin`,
        [coins],
      );
      const pairs = coins.map((coin) => [coin, creators.get(coin) ?? ""]);
      const dev = await rows<Row>(
        index,
        `SELECT p.coin, COALESCE(b.amount, 0) AS amount
           FROM UNNEST($1::text[], $2::text[]) AS p(coin, account)
           LEFT JOIN balance b ON b.coin = p.coin AND b.account = p.account`,
        [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
      );
      for (const r of top) out.set(String(r.coin), { top10: big(r.top10 as string), creatorBalance: 0n });
      for (const r of dev) {
        const entry = out.get(String(r.coin));
        if (entry) entry.creatorBalance = big(r.amount as string);
      }
      return out;
    },

    async windows(coins, nowSec) {
      const out = new Map<string, WindowAggregates>();
      if (coins.length === 0) return out;
      // 24h from 5-minute candles, the last hour and 15 minutes from 1-minute candles, and the
      // price at each look-back moment from the last 1-minute close that ended by then (an index
      // seek per coin on the candle primary key).
      const result = await rows<Row>(
        index,
        `SELECT c.coin,
                (SELECT COALESCE(SUM(volume_usd_e_8), 0) FROM candle WHERE coin = c.coin AND pool_id = ('0x' || repeat('0', 24) || substring(c.coin from 3)) AND interval = 300 AND bucket + 300 > $2) AS vol24h,
                (SELECT COALESCE(SUM(trades), 0) FROM candle WHERE coin = c.coin AND pool_id = ('0x' || repeat('0', 24) || substring(c.coin from 3)) AND interval = 300 AND bucket + 300 > $2) AS trades24h,
                (SELECT COALESCE(SUM(buys), 0) FROM candle WHERE coin = c.coin AND pool_id = ('0x' || repeat('0', 24) || substring(c.coin from 3)) AND interval = 300 AND bucket + 300 > $2) AS buys24h,
                (SELECT COALESCE(SUM(volume_usd_e_8), 0) FROM candle WHERE coin = c.coin AND pool_id = ('0x' || repeat('0', 24) || substring(c.coin from 3)) AND interval = 60 AND bucket + 60 > $3) AS vol1h,
                (SELECT COALESCE(SUM(trades), 0) FROM candle WHERE coin = c.coin AND pool_id = ('0x' || repeat('0', 24) || substring(c.coin from 3)) AND interval = 60 AND bucket + 60 > $4) AS trades15m,
                (SELECT close_usd_e_18 FROM candle WHERE coin = c.coin AND pool_id = ('0x' || repeat('0', 24) || substring(c.coin from 3)) AND interval = 60 AND bucket + 60 <= $5 ORDER BY bucket DESC LIMIT 1) AS p5m,
                (SELECT close_usd_e_18 FROM candle WHERE coin = c.coin AND pool_id = ('0x' || repeat('0', 24) || substring(c.coin from 3)) AND interval = 60 AND bucket + 60 <= $3 ORDER BY bucket DESC LIMIT 1) AS p1h,
                (SELECT close_usd_e_18 FROM candle WHERE coin = c.coin AND pool_id = ('0x' || repeat('0', 24) || substring(c.coin from 3)) AND interval = 60 AND bucket + 60 <= $2 ORDER BY bucket DESC LIMIT 1) AS p24h
           FROM UNNEST($1::text[]) AS c(coin)`,
        [coins, nowSec - 86_400, nowSec - 3_600, nowSec - 900, nowSec - 300],
      );
      for (const r of result) {
        out.set(String(r.coin), {
          volume24hUsdE8: big(r.vol24h as string),
          trades24h: num(r.trades24h),
          buys24h: num(r.buys24h),
          volume1hUsdE8: big(r.vol1h as string),
          trades15m: num(r.trades15m),
          priceAgo: { m5: opt(r.p5m), h1: opt(r.p1h), h24: opt(r.p24h) },
        });
      }
      return out;
    },

    async marketWindows(coins, nowSec) {
      const out = new Map<string, WindowAggregates>();
      if (coins.length === 0) return out;
      // 24h from 5-minute candles, the last hour and 15 minutes from 1-minute candles, and the
      // price at each look-back moment from the last 1-minute close that ended by then (an index
      // seek per coin on the candle primary key).
      const result = await rows<Row>(
        index,
        `SELECT c.coin,
                (SELECT COALESCE(SUM(volume_usd_e_8), 0) FROM candle WHERE pool_id = c.coin AND interval = 300 AND bucket + 300 > $2) AS vol24h,
                (SELECT COALESCE(SUM(trades), 0) FROM candle WHERE pool_id = c.coin AND interval = 300 AND bucket + 300 > $2) AS trades24h,
                (SELECT COALESCE(SUM(buys), 0) FROM candle WHERE pool_id = c.coin AND interval = 300 AND bucket + 300 > $2) AS buys24h,
                (SELECT COALESCE(SUM(volume_usd_e_8), 0) FROM candle WHERE pool_id = c.coin AND interval = 60 AND bucket + 60 > $3) AS vol1h,
                (SELECT COALESCE(SUM(trades), 0) FROM candle WHERE pool_id = c.coin AND interval = 60 AND bucket + 60 > $4) AS trades15m,
                (SELECT close_usd_e_18 FROM candle WHERE pool_id = c.coin AND interval = 60 AND bucket + 60 <= $5 ORDER BY bucket DESC LIMIT 1) AS p5m,
                (SELECT close_usd_e_18 FROM candle WHERE pool_id = c.coin AND interval = 60 AND bucket + 60 <= $3 ORDER BY bucket DESC LIMIT 1) AS p1h,
                (SELECT close_usd_e_18 FROM candle WHERE pool_id = c.coin AND interval = 60 AND bucket + 60 <= $2 ORDER BY bucket DESC LIMIT 1) AS p24h
           FROM UNNEST($1::text[]) AS c(coin)`,
        [coins, nowSec - 86_400, nowSec - 3_600, nowSec - 900, nowSec - 300],
      );
      for (const r of result) {
        out.set(String(r.coin), {
          volume24hUsdE8: big(r.vol24h as string),
          trades24h: num(r.trades24h),
          buys24h: num(r.buys24h),
          volume1hUsdE8: big(r.vol1h as string),
          trades15m: num(r.trades15m),
          priceAgo: { m5: opt(r.p5m), h1: opt(r.p1h), h24: opt(r.p24h) },
        });
      }
      return out;
    },

    async sparklineCloses(coins, fromSec) {
      const out = new Map<string, Array<{ bucket: number; close: bigint }>>();
      if (coins.length === 0) return out;
      const result = await rows<Row>(
        index,
        `SELECT coin, bucket, close_usd_e_18 FROM candle
          WHERE coin = ANY($1::text[]) AND pool_id = ('0x' || repeat('0', 24) || substring(coin from 3)) AND interval = 900 AND bucket + 900 > $2
          ORDER BY coin, bucket`,
        [coins, fromSec],
      );
      for (const r of result) {
        const list = out.get(String(r.coin)) ?? [];
        list.push({ bucket: num(r.bucket), close: big(r.close_usd_e_18 as string) });
        out.set(String(r.coin), list);
      }
      return out;
    },

    async trades(coin, options) {
      const params: unknown[] = [coin, options.limit];
      let where = `coin = $1`;
      if (options.before) {
        params.push(options.before.blockNumber.toString(), options.before.logIndex);
        where += ` AND (block_number, log_index) < ($3::numeric, $4::int)`;
      }
      if (options.poolId) {
        params.push(options.poolId);
        where += ` AND pool_id = $${params.length}`;
      }
      return (
        await rows<Row>(index, `SELECT ${TRADE_COLUMNS} FROM trade WHERE ${where} ORDER BY block_number DESC, log_index DESC LIMIT $2`, params)
      ).map(tradeRecord);
    },

    async tradesByTrader(trader, limit) {
      return (
        await rows<Row>(index, `SELECT ${TRADE_COLUMNS} FROM trade WHERE trader = $1 ORDER BY timestamp DESC, block_number DESC, log_index DESC LIMIT $2`, [
          trader,
          limit,
        ])
      ).map(tradeRecord);
    },

    async tradesAfter(cursor, limit) {
      return (
        await rows<Row>(
          index,
          `SELECT ${TRADE_COLUMNS} FROM trade WHERE (block_number, log_index) > ($1::numeric, $2::int) ORDER BY block_number, log_index LIMIT $3`,
          [cursor.blockNumber.toString(), cursor.logIndex, limit],
        )
      ).map(tradeRecord);
    },

    async recentTrades(limit) {
      return (await rows<Row>(index, `SELECT ${TRADE_COLUMNS} FROM trade ORDER BY block_number DESC, log_index DESC LIMIT $1`, [limit])).map(tradeRecord);
    },

    async candles(coin, interval, fromBucket, metric, poolId) {
      const [o, h, l, c] =
        metric === "price"
          ? ["open_usd_e_18", "high_usd_e_18", "low_usd_e_18", "close_usd_e_18"]
          : ["open_mcap_usd_e_8", "high_mcap_usd_e_8", "low_mcap_usd_e_8", "close_mcap_usd_e_8"];
      const result = await rows<Row>(
        index,
        `SELECT bucket, ${o} AS o, ${h} AS h, ${l} AS l, ${c} AS c, volume_usd_e_8 AS v
           FROM candle WHERE coin = $1 AND interval = $2 AND bucket >= $3
             AND pool_id = COALESCE($4::text, (SELECT pool_id FROM coin WHERE address = $1)) ORDER BY bucket`,
        [coin, interval, fromBucket, poolId ?? null],
      );
      return result.map((r) => ({
        bucket: num(r.bucket),
        open: big(r.o as string),
        high: big(r.h as string),
        low: big(r.l as string),
        close: big(r.c as string),
        volumeUsdE8: big(r.v as string),
      }));
    },

    async lastCloseBefore(coin, interval, bucket, metric, poolId) {
      const column = metric === "price" ? "close_usd_e_18" : "close_mcap_usd_e_8";
      const [row] = await rows<Row>(
        index,
        `SELECT ${column} AS c FROM candle WHERE coin = $1 AND interval = $2 AND bucket < $3
          AND pool_id = COALESCE($4::text, (SELECT pool_id FROM coin WHERE address = $1)) ORDER BY bucket DESC LIMIT 1`,
        [coin, interval, bucket, poolId ?? null],
      );
      return row ? big(row.c as string) : null;
    },

    async holders(coin, limit) {
      const result = await rows<Row>(
        index,
        `SELECT account, amount FROM balance WHERE coin = $1 AND amount > 0 ORDER BY amount DESC, account LIMIT $2`,
        [coin, limit],
      );
      return result.map((r) => ({ account: String(r.account), amount: big(r.amount as string) }));
    },

    async balance(coin, account) {
      const [r] = await rows<Row>(index, `SELECT coin, account, amount, bought_coins, bought_usd_e_8 FROM balance WHERE coin = $1 AND account = $2`, [
        coin,
        account,
      ]);
      return r
        ? { coin: String(r.coin), account: String(r.account), amount: big(r.amount as string), boughtCoins: big(r.bought_coins as string), boughtUsdE8: big(r.bought_usd_e_8 as string) }
        : null;
    },

    async balancesOf(account) {
      const result = await rows<Row>(
        index,
        `SELECT coin, account, amount, bought_coins, bought_usd_e_8 FROM balance WHERE account = $1 AND amount > 0`,
        [account],
      );
      return result.map((r) => ({
        coin: String(r.coin),
        account: String(r.account),
        amount: big(r.amount as string),
        boughtCoins: big(r.bought_coins as string),
        boughtUsdE8: big(r.bought_usd_e_8 as string),
      }));
    },

    async activity(options) {
      const params: unknown[] = [options.limit];
      let where = "";
      if (options.after) {
        params.push(options.after.blockNumber.toString(), options.after.logIndex);
        where = `WHERE (block_number, log_index) > ($2::numeric, $3::int)`;
      }
      const result = await rows<Row>(
        index,
        `SELECT id, kind, coin, pool_id, currency, amount_quote, amount_coins, milestone_usd, block_number, log_index, timestamp
           FROM activity ${where} ORDER BY block_number DESC, log_index DESC LIMIT $1`,
        params,
      );
      return result.map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        coin: String(r.coin),
        poolId: r.pool_id ? String(r.pool_id) : null,
        currency: r.currency ? String(r.currency) : null,
        amountQuote: opt(r.amount_quote),
        amountCoins: opt(r.amount_coins),
        milestoneUsd: r.milestone_usd === null ? null : num(r.milestone_usd),
        blockNumber: big(r.block_number as string),
        logIndex: num(r.log_index),
        timestamp: num(r.timestamp),
      }));
    },

    async referralLedger(referrer) {
      const result = await rows<Row>(index, `SELECT currency, earned, claimed FROM referral_ledger WHERE referrer = $1`, [referrer]);
      return result.map((r) => ({ currency: String(r.currency), earned: big(r.earned as string), claimed: big(r.claimed as string) }));
    },

    async holderClaimsOf(account) {
      const result = await rows<Row>(index, `SELECT epoch, coin, pool_id, index FROM holder_claim WHERE account = $1`, [account]);
      return new Set(result.flatMap((r) => [`${r.epoch}:${r.pool_id}:${r.index}`, `${r.epoch}:${r.coin}:${r.index}`]));
    },

    async epochs() {
      const result = await rows<Row>(index, `SELECT epoch, published_at, vetoed FROM epoch`);
      return new Map(result.map((r) => [String(r.epoch), { publishedAt: num(r.published_at), vetoed: Boolean(r.vetoed) }]));
    },

    async platformTotals() {
      const [r] = await rows<Row>(index, `SELECT COUNT(*) AS coins, COALESCE(SUM(trades), 0) AS trades, COALESCE(SUM(volume_usd_e_8), 0) AS volume FROM coin WHERE launched = true`);
      return { coins: num(r?.coins), trades: num(r?.trades), volumeUsdE8: big(r?.volume as string) };
    },

    async pool(coin, poolId) {
      const [c] = await rows<Row>(
        index,
        `SELECT pool_id, quote, quote_is_currency0, start_tick, liquidity, sqrt_price_x_96, tick FROM market
          WHERE address = $1 AND launched = true AND pool_id = COALESCE($2::text, (SELECT pool_id FROM coin WHERE address = $1))`,
        [coin, poolId ?? null],
      );
      if (!c) return null;
      const floors = await rows<Row>(index, `SELECT tick_lower, tick_upper, liquidity FROM floor_add WHERE pool_id = $1 ORDER BY block_number, id`, [c.pool_id]);
      return {
        poolId: String(c.pool_id),
        quote: String(c.quote),
        quoteIsCurrency0: Boolean(c.quote_is_currency0),
        startTick: num(c.start_tick),
        liquidity: big(c.liquidity as string),
        sqrtPriceX96: big(c.sqrt_price_x_96 as string),
        tick: num(c.tick),
        floors: floors.map((f) => ({ tickLower: num(f.tick_lower), tickUpper: num(f.tick_upper), liquidity: big(f.liquidity as string) })),
      };
    },
  };
}

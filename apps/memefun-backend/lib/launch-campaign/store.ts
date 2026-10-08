import { type Address, getAddress } from "viem";
import { type Queryable, rows } from "../db";

export interface CampaignLaunch { wallet: Address; coin: Address; slot: number; launchBlock: bigint }

/** Ponder 0.17's 75-digit checkpoint: timestamp(10), chain(16), block(16), event position(33). */
export function checkpointCovers(checkpoint: string | undefined, chainId: number, block: bigint): boolean {
  if (!checkpoint || !/^\d{75}$/.test(checkpoint) || BigInt(checkpoint.slice(10, 26)) !== BigInt(chainId)) return false;
  const indexedBlock = BigInt(checkpoint.slice(26, 42));
  // A checkpoint inside the boundary block may precede another launch in that same block.
  return indexedBlock > block || (indexedBlock === block && /^9{33}$/.test(checkpoint.slice(42)));
}

export function createCampaignStore(index: Queryable, app: Queryable, excludedTradeSenders: Address[]) {
  return {
    async caughtUp(chainId: number, finalizedBlock: bigint) {
      const checkpoints = await rows<{ chain_id: number | string; latest_checkpoint: string; finalized_checkpoint: string }>(index,
        `SELECT chain_id, latest_checkpoint, finalized_checkpoint FROM _ponder_checkpoint`);
      // The app indexes exactly one chain. In Ponder's multichain ordering, finalized_checkpoint
      // advances atomically with pruning that chain's undo prefix. safe_checkpoint only records
      // the last pruned user event, so it may lag across fully processed quiet blocks.
      // Refuse a multichain table: another chain can retain earlier undo operations in the prefix.
      if (checkpoints.length !== 1 || Number(checkpoints[0]?.chain_id) !== chainId) return false;
      const row = checkpoints[0]!;
      return checkpointCovers(row?.latest_checkpoint, chainId, finalizedBlock)
        && checkpointCovers(row?.finalized_checkpoint, chainId, finalizedBlock);
    },
    /** Rank launches, never HTTP claim requests. One immutable launcher gets its first coin only.
     * No moderation or market joins: visibility and number of quote pools cannot change slots. */
    async launches(startBlock: bigint, finalizedBlock: bigint): Promise<CampaignLaunch[]> {
      const result = await rows<{ wallet: Address; coin: Address; launch_block: string; slot: string }>(index, `
        WITH first_launch AS (
          SELECT DISTINCT ON (c.launcher) c.launcher AS wallet, c.address AS coin,
            a.block_number AS launch_block, a.log_index
          FROM activity a JOIN coin c ON c.address = a.coin
          WHERE a.kind = 'launch' AND c.launched = true
            AND a.block_number > $1::numeric AND a.block_number <= $2::numeric
          ORDER BY c.launcher, a.block_number, a.log_index, c.address
        ), ranked AS (
          SELECT *, ROW_NUMBER() OVER (ORDER BY launch_block, log_index, coin) - 1 AS slot FROM first_launch
        ) SELECT wallet, coin, launch_block, slot FROM ranked WHERE slot < 1000 ORDER BY slot`,
      [startBlock.toString(), finalizedBlock.toString()]);
      return result.map(r => ({ wallet: getAddress(r.wallet), coin: getAddress(r.coin), slot: Number(r.slot), launchBlock: BigInt(r.launch_block) }));
    },
    async hasLaunch(wallet: Address, startBlock: bigint, afterBlock: bigint) {
      const result = await index.query(`SELECT 1 FROM activity a JOIN coin c ON c.address = a.coin
        WHERE a.kind = 'launch' AND c.launched = true AND c.launcher = $1
          AND a.block_number > $2::numeric AND a.block_number > $3::numeric LIMIT 1`,
      [wallet.toLowerCase(), startBlock.toString(), afterBlock.toString()]);
      return result.rows.length > 0;
    },
    /** Any MemeFun token, but a positive regular wallet swap in a later finalized block.
     * First buys and protocol/module operations cannot satisfy the future trade rule. */
    async tradeBlock(wallet: Address, launchBlock: bigint, finalizedBlock: bigint): Promise<bigint | null> {
      const [trade] = await rows<{ block_number: string }>(index, `SELECT t.block_number FROM trade t
        JOIN coin c ON c.address = t.coin
        WHERE t.trader = $1 AND t.kind = 'trade' AND c.launched = true
          AND t.quote_amount > 0 AND t.coin_amount > 0
          AND t.block_number > $2::numeric AND t.block_number <= $3::numeric
          AND NOT (t.sender = ANY($4::text[])) AND NOT (t.trader = ANY($4::text[]))
        ORDER BY t.block_number, t.log_index LIMIT 1`,
      [wallet.toLowerCase(), launchBlock.toString(), finalizedBlock.toString(), excludedTradeSenders.map(a => a.toLowerCase())]);
      return trade ? BigInt(trade.block_number) : null;
    },
    /** Shared, atomic fixed-window budget. Failed eligibility requests consume a ticket attempt. */
    async quota(key: string, limit: number, windowSec: number, nowSec = Math.floor(Date.now() / 1000)) {
      const windowStart = Math.floor(nowSec / windowSec) * windowSec;
      const [r] = await rows<{ count: number }>(app, `INSERT INTO launch_campaign_quota (key, window_start, count, expires_at)
        VALUES ($1, $2::bigint, 1, to_timestamp(($2::bigint + $3::bigint)::double precision))
        ON CONFLICT (key, window_start) DO UPDATE SET count = LEAST(launch_campaign_quota.count + 1, $4::integer + 1)
        RETURNING count`, [key, windowStart, windowSec, limit]);
      return (r?.count ?? limit + 1) <= limit;
    },
    async prune() { await app.query(`DELETE FROM launch_campaign_quota WHERE expires_at <= now()`); },
  };
}
export type CampaignStore = ReturnType<typeof createCampaignStore>;

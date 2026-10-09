import type pg from "pg";
import { type Address, type Hex, getAddress } from "viem";
import { type Queryable, rows } from "../db";
import { checkpointCovers } from "../launch-campaign/store";

export interface PlatformScope { chainId: number; factory: Address }
export interface PlatformIntent {
  coin: Address; launcher: Address; salt: Hex; contractURI: string; afterBlock: bigint; createdAt: string;
}
export interface PlatformLaunch {
  coin: Address; launcher: Address; contractURI: string; launchBlock: bigint; logIndex: number; txHash: Hex;
}
export interface PlatformPin extends PlatformLaunch { blockHash: Hex }
type Row = Record<string, unknown>;
function intent(r: Row): PlatformIntent {
  return { coin: getAddress(String(r.coin)), launcher: getAddress(String(r.launcher)), salt: String(r.salt) as Hex,
    contractURI: String(r.contract_uri), afterBlock: BigInt(String(r.after_block)),
    createdAt: (r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at))).toISOString() };
}
function launch(r: Row): PlatformLaunch {
  return { coin: getAddress(String(r.coin)), launcher: getAddress(String(r.launcher)), contractURI: String(r.contract_uri),
    launchBlock: BigInt(String(r.launch_block)), logIndex: Number(r.log_index), txHash: String(r.tx_hash) as Hex };
}

export function createPlatformTokenStore(index: Queryable, app: Pick<pg.Pool, "query" | "connect">) {
  const scopeParams = (s: PlatformScope) => [s.chainId, s.factory.toLowerCase()];
  /** RPC calls happen before this short transaction. A per-factory lock serializes prepare/pin. */
  const locked = async <T>(scope: PlatformScope, action: (db: Queryable) => Promise<T>): Promise<T> => {
    const db = await app.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`platform-token:${scope.chainId}:${scope.factory.toLowerCase()}`]);
      const result = await action(db);
      await db.query("COMMIT");
      return result;
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
  };
  return {
    async pin(scope: PlatformScope): Promise<PlatformPin | null> {
      const [r] = await rows<Row>(app, "SELECT * FROM platform_token_pin WHERE chain_id = $1 AND factory = $2", scopeParams(scope));
      return r ? { ...launch(r), blockHash: String(r.block_hash) as Hex } : null;
    },
    async intent(scope: PlatformScope, salt: Hex): Promise<PlatformIntent | null> {
      const [r] = await rows<Row>(app, "SELECT * FROM platform_token_intent WHERE chain_id = $1 AND factory = $2 AND salt = $3", [...scopeParams(scope), salt.toLowerCase()]);
      return r ? intent(r) : null;
    },
    async prepare(scope: PlatformScope, input: Omit<PlatformIntent, "createdAt">): Promise<{ state: "pinned" } | { state: "conflict" } | { state: "created" | "existing"; intent: PlatformIntent }> {
      return locked(scope, async db => {
        const pinned = await rows<Row>(db, "SELECT coin FROM platform_token_pin WHERE chain_id = $1 AND factory = $2", scopeParams(scope));
        if (pinned.length) return { state: "pinned" };
        const [existing] = await rows<Row>(db, "SELECT * FROM platform_token_intent WHERE chain_id = $1 AND factory = $2 AND salt = $3", [...scopeParams(scope), input.salt.toLowerCase()]);
        if (existing) return String(existing.coin) === input.coin.toLowerCase() && String(existing.launcher) === input.launcher.toLowerCase() && existing.contract_uri === input.contractURI
          ? { state: "existing", intent: intent(existing) } : { state: "conflict" };
        const [r] = await rows<Row>(db, `INSERT INTO platform_token_intent (chain_id, factory, coin, launcher, salt, contract_uri, after_block)
          VALUES ($1, $2, $3, $4, $5, $6, $7::numeric) RETURNING *`,
        [...scopeParams(scope), input.coin.toLowerCase(), input.launcher.toLowerCase(), input.salt.toLowerCase(), input.contractURI, input.afterBlock.toString()]);
        return { state: "created", intent: intent(r!) };
      });
    },
    /** A complete latest checkpoint is sufficient for this nonmonetary identity badge.
     * The service independently checks the canonical receipt, and never repins after a reorg. */
    async ready(chainId: number, block: bigint) {
      const checkpoints = await rows<{ chain_id: number | string; latest_checkpoint: string }>(index, "SELECT chain_id, latest_checkpoint FROM _ponder_checkpoint");
      return checkpoints.length === 1 && Number(checkpoints[0]?.chain_id) === chainId
        && checkpointCovers(checkpoints[0]?.latest_checkpoint, chainId, block);
    },
    async candidate(scope: PlatformScope, throughBlock: bigint, launcher: Address): Promise<PlatformLaunch | null> {
      const [r] = await rows<Row>(index, `SELECT c.address AS coin, c.launcher, c.contract_uri,
          a.block_number AS launch_block, a.log_index, a.tx_hash
        FROM activity a JOIN coin c ON c.address = a.coin
        JOIN memefun_app.platform_token_intent i ON i.coin = c.address AND i.launcher = c.launcher
          AND i.contract_uri = c.contract_uri AND i.chain_id = $1 AND i.factory = $2
        WHERE a.kind = 'launch' AND c.launched = true AND c.launch_tx = a.tx_hash AND i.launcher = $4
          AND a.block_number > i.after_block AND a.block_number <= $3::numeric
          AND a.timestamp >= FLOOR(EXTRACT(EPOCH FROM i.created_at))
        ORDER BY a.block_number, a.log_index, c.address LIMIT 1`, [...scopeParams(scope), throughBlock.toString(), launcher.toLowerCase()]);
      return r ? launch(r) : null;
    },
    async register(scope: PlatformScope, input: PlatformPin): Promise<PlatformPin> {
      return locked(scope, async db => {
        await db.query(`INSERT INTO platform_token_pin (chain_id, factory, coin, launcher, contract_uri, launch_block, log_index, tx_hash, block_hash)
          VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9) ON CONFLICT (chain_id, factory) DO NOTHING`,
        [...scopeParams(scope), input.coin.toLowerCase(), input.launcher.toLowerCase(), input.contractURI, input.launchBlock.toString(), input.logIndex, input.txHash.toLowerCase(), input.blockHash.toLowerCase()]);
        const [r] = await rows<Row>(db, "SELECT * FROM platform_token_pin WHERE chain_id = $1 AND factory = $2", scopeParams(scope));
        return { ...launch(r!), blockHash: String(r!.block_hash) as Hex };
      });
    },
    async quota(key: string, limit: number, windowSec: number, nowSec = Math.floor(Date.now() / 1000)) {
      const windowStart = Math.floor(nowSec / windowSec) * windowSec;
      const [r] = await rows<{ count: number }>(app, `INSERT INTO platform_token_quota (key, window_start, count, expires_at)
        VALUES ($1, $2::bigint, 1, to_timestamp(($2::bigint + $3::bigint)::double precision))
        ON CONFLICT (key, window_start) DO UPDATE SET count = LEAST(platform_token_quota.count + 1, $4::integer + 1)
        RETURNING count`, [key, windowStart, windowSec, limit]);
      return (r?.count ?? limit + 1) <= limit;
    },
    async prune() { await app.query("DELETE FROM platform_token_quota WHERE expires_at <= now()"); },
  };
}
export type PlatformTokenStore = ReturnType<typeof createPlatformTokenStore>;

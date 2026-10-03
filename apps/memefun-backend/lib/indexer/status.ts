import { type Queryable, rows } from "../db";

/**
 * How far the index has got, as a block timestamp. Ponder's checkpoint strings start with the
 * 10-digit block timestamp of the last processed event (see ponder/utils/checkpoint), so anything
 * that must not run on a lagging index (holder-reward epochs) can wait for it.
 */
export async function indexedUntil(index: Queryable, chainId: number): Promise<number | null> {
  const [row] = await rows<{ latest_checkpoint: string }>(index, `SELECT latest_checkpoint FROM _ponder_checkpoint WHERE chain_id = $1`, [chainId]);
  if (!row?.latest_checkpoint || row.latest_checkpoint.length < 10) return null;
  const timestamp = Number(row.latest_checkpoint.slice(0, 10));
  return Number.isFinite(timestamp) ? timestamp : null;
}

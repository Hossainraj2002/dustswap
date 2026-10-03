import type pg from "pg";

import { type Queryable, big, rows } from "./db";
import type { CoinLinks } from "../shared/core/types";

/**
 * memefun_app: what the backend owns that is not on chain. Used by the API (reads and writes) and
 * the keeper (metadata resolution, reward epochs, run log). Every address is lowercase.
 */

export interface MetadataRecord {
  cid: string;
  name: string;
  symbol: string;
  description: string;
  imageUri: string | null;
  links: CoinLinks;
  source: "api" | "fetched";
}

export interface CommentRecord {
  id: string;
  coin: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface ReportRecord {
  id: string;
  targetKind: "coin" | "comment";
  targetId: string;
  reason: string;
  details: string;
  reporter: string | null;
  status: "open" | "dismissed" | "actioned";
  createdAt: number;
}

export interface RewardLeafRecord {
  epoch: bigint;
  coin: string;
  index: bigint;
  account: string;
  amount: bigint;
  proof: `0x${string}`[];
}

type Row = Record<string, unknown>;
const ms = (value: unknown) => new Date(value as string).getTime();

function metadataRecord(r: Row): MetadataRecord {
  return {
    cid: String(r.cid),
    name: String(r.name),
    symbol: String(r.symbol),
    description: String(r.description),
    imageUri: r.image_uri === null ? null : String(r.image_uri),
    links: (r.links ?? {}) as CoinLinks,
    source: r.source as "api" | "fetched",
  };
}

export function createAppStore(db: Queryable & Pick<pg.Pool, "connect">) {
  return {
    // ----------------------------------------------------------------------------- metadata

    async saveMetadata(m: MetadataRecord) {
      await db.query(
        `INSERT INTO metadata (cid, name, symbol, description, image_uri, links, source)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (cid) DO NOTHING`,
        [m.cid, m.name, m.symbol, m.description, m.imageUri, JSON.stringify(m.links), m.source],
      );
    },

    async metadataByCids(cids: string[]): Promise<Map<string, MetadataRecord>> {
      if (cids.length === 0) return new Map();
      const result = await rows<Row>(db, `SELECT * FROM metadata WHERE cid = ANY($1::text[])`, [cids]);
      return new Map(result.map((r) => [String(r.cid), metadataRecord(r)]));
    },

    /** Coins whose contractURI still needs resolving, oldest due first. */
    async dueCoinMetadata(limit: number) {
      return rows<{ coin: string; contract_uri: string; attempts: number }>(
        db,
        `SELECT coin, contract_uri, attempts FROM coin_metadata
          WHERE status IN ('pending', 'failed') AND next_attempt <= now()
          ORDER BY next_attempt LIMIT $1`,
        [limit],
      );
    },

    async knownCoinMetadata(): Promise<Set<string>> {
      return new Set((await rows<{ coin: string }>(db, `SELECT coin FROM coin_metadata`)).map((r) => r.coin));
    },

    async enqueueCoinMetadata(coin: string, contractUri: string) {
      await db.query(
        `INSERT INTO coin_metadata (coin, contract_uri, status) VALUES ($1, $2, 'pending') ON CONFLICT (coin) DO NOTHING`,
        [coin, contractUri],
      );
    },

    async resolveCoinMetadata(coin: string, status: "resolved" | "failed" | "unsupported", detail: { cid?: string; error?: string; retryInSec?: number }) {
      await db.query(
        `UPDATE coin_metadata
            SET status = $2, cid = COALESCE($3, cid), last_error = $4, attempts = attempts + 1,
                next_attempt = now() + make_interval(secs => $5), updated_at = now()
          WHERE coin = $1`,
        [coin, status, detail.cid ?? null, detail.error ?? null, detail.retryInSec ?? 0],
      );
    },

    async coinMetadataCids(): Promise<Map<string, string>> {
      const result = await rows<{ coin: string; cid: string }>(db, `SELECT coin, cid FROM coin_metadata WHERE status = 'resolved' AND cid IS NOT NULL`);
      return new Map(result.map((r) => [r.coin, r.cid]));
    },

    async hasUpload(cid: string, kind: "image" | "metadata"): Promise<boolean> {
      const [r] = await rows<{ n: string }>(db, `SELECT COUNT(*) AS n FROM upload WHERE cid = $1 AND kind = $2`, [cid, kind]);
      return Number(r?.n ?? 0) > 0;
    },

    /** Uploads in the last `sinceSec` seconds by this wallet, or else by this network. */
    async recentUploads(by: { wallet: string | null; ipHash: string }, sinceSec: number): Promise<number> {
      const [r] = by.wallet
        ? await rows<{ n: string }>(db, `SELECT COUNT(*) AS n FROM upload WHERE uploader = $1 AND created_at > now() - make_interval(secs => $2)`, [by.wallet, sinceSec])
        : await rows<{ n: string }>(db, `SELECT COUNT(*) AS n FROM upload WHERE ip_hash = $1 AND created_at > now() - make_interval(secs => $2)`, [by.ipHash, sinceSec]);
      return Number(r?.n ?? 0);
    },

    async recordUpload(upload: { cid: string; kind: "image" | "metadata"; bytes: number; uploader: string | null; ipHash: string }) {
      await db.query(
        `INSERT INTO upload (cid, kind, bytes, uploader, ip_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (cid) DO NOTHING`,
        [upload.cid, upload.kind, upload.bytes, upload.uploader, upload.ipHash],
      );
    },

    // --------------------------------------------------------------------------- moderation

    async moderation(): Promise<Map<string, { hidden: boolean; featured: boolean; note: string }>> {
      const result = await rows<Row>(db, `SELECT coin, hidden, featured, note FROM moderation`);
      return new Map(result.map((r) => [String(r.coin), { hidden: Boolean(r.hidden), featured: Boolean(r.featured), note: String(r.note) }]));
    },

    async setModeration(coin: string, change: { hidden?: boolean; featured?: boolean; note?: string }) {
      await db.query(
        `INSERT INTO moderation (coin, hidden, featured, note) VALUES ($1, COALESCE($2, false), COALESCE($3, false), COALESCE($4, ''))
         ON CONFLICT (coin) DO UPDATE SET
           hidden = COALESCE($2, moderation.hidden),
           featured = COALESCE($3, moderation.featured),
           note = COALESCE($4, moderation.note),
           updated_at = now()`,
        [coin, change.hidden ?? null, change.featured ?? null, change.note ?? null],
      );
    },

    async setting<T>(key: string): Promise<T | null> {
      const [row] = await rows<{ value: T }>(db, `SELECT value FROM setting WHERE key = $1`, [key]);
      return row ? row.value : null;
    },

    async setSetting(key: string, value: unknown) {
      await db.query(
        `INSERT INTO setting (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    },

    // ----------------------------------------------------------------------------- comments

    async comments(coin: string, limit: number): Promise<CommentRecord[]> {
      const result = await rows<Row>(
        db,
        `SELECT id, coin, author, body, created_at FROM comment WHERE coin = $1 AND hidden = false ORDER BY created_at DESC, id DESC LIMIT $2`,
        [coin, limit],
      );
      return result.map((r) => ({ id: String(r.id), coin: String(r.coin), author: String(r.author), body: String(r.body), createdAt: ms(r.created_at) }));
    },

    async addComment(coin: string, author: string, body: string): Promise<CommentRecord> {
      const [r] = await rows<Row>(db, `INSERT INTO comment (coin, author, body) VALUES ($1, $2, $3) RETURNING id, coin, author, body, created_at`, [
        coin,
        author,
        body,
      ]);
      return { id: String(r!.id), coin: String(r!.coin), author: String(r!.author), body: String(r!.body), createdAt: ms(r!.created_at) };
    },

    async recentCommentCount(author: string, sinceSec: number): Promise<number> {
      const [r] = await rows<{ n: string }>(db, `SELECT COUNT(*) AS n FROM comment WHERE author = $1 AND created_at > now() - make_interval(secs => $2)`, [
        author,
        sinceSec,
      ]);
      return Number(r?.n ?? 0);
    },

    async lastCommentBody(author: string, coin: string): Promise<string | null> {
      const [r] = await rows<{ body: string }>(db, `SELECT body FROM comment WHERE author = $1 AND coin = $2 ORDER BY created_at DESC LIMIT 1`, [author, coin]);
      return r?.body ?? null;
    },

    async hideComment(id: string, hidden: boolean): Promise<boolean> {
      const result = await db.query(`UPDATE comment SET hidden = $2 WHERE id = $1`, [id, hidden]);
      return (result.rowCount ?? 0) > 0;
    },

    // ------------------------------------------------------------------------------ reports

    async addReport(report: { targetKind: "coin" | "comment"; targetId: string; reason: string; details: string; reporter: string | null; ipHash: string }) {
      const [r] = await rows<{ id: string }>(
        db,
        `INSERT INTO report (target_kind, target_id, reason, details, reporter, ip_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [report.targetKind, report.targetId, report.reason, report.details, report.reporter, report.ipHash],
      );
      return String(r!.id);
    },

    async reports(status: "open" | "dismissed" | "actioned", limit: number): Promise<ReportRecord[]> {
      const result = await rows<Row>(db, `SELECT * FROM report WHERE status = $1 ORDER BY created_at DESC LIMIT $2`, [status, limit]);
      return result.map((r) => ({
        id: String(r.id),
        targetKind: r.target_kind as "coin" | "comment",
        targetId: String(r.target_id),
        reason: String(r.reason),
        details: String(r.details),
        reporter: r.reporter === null ? null : String(r.reporter),
        status: r.status as ReportRecord["status"],
        createdAt: ms(r.created_at),
      }));
    },

    async resolveReport(id: string, status: "dismissed" | "actioned"): Promise<boolean> {
      const result = await db.query(`UPDATE report SET status = $2, resolved_at = now() WHERE id = $1 AND status = 'open'`, [id, status]);
      return (result.rowCount ?? 0) > 0;
    },

    async recentReportCount(ipHash: string, sinceSec: number): Promise<number> {
      const [r] = await rows<{ n: string }>(db, `SELECT COUNT(*) AS n FROM report WHERE ip_hash = $1 AND created_at > now() - make_interval(secs => $2)`, [
        ipHash,
        sinceSec,
      ]);
      return Number(r?.n ?? 0);
    },

    // ------------------------------------------------------------------------ holder rewards

    async rewardLeavesOf(account: string): Promise<RewardLeafRecord[]> {
      const result = await rows<Row>(
        db,
        `SELECT l.epoch, l.coin, l.idx, l.account, l.amount, l.proof
           FROM reward_leaf l JOIN reward_epoch e ON e.epoch = l.epoch
          WHERE l.account = $1 AND e.status = 'published'
          ORDER BY l.epoch DESC`,
        [account],
      );
      return result.map((r) => ({
        epoch: big(r.epoch as string),
        coin: String(r.coin),
        index: big(r.idx as string),
        account: String(r.account),
        amount: big(r.amount as string),
        proof: r.proof as `0x${string}`[],
      }));
    },

    async lastRewardEpoch() {
      const [r] = await rows<Row>(db, `SELECT * FROM reward_epoch ORDER BY epoch DESC LIMIT 1`);
      return r
        ? {
            epoch: big(r.epoch as string),
            windowStart: Number(r.window_start),
            windowEnd: Number(r.window_end),
            status: String(r.status) as "built" | "published" | "failed",
            root: String(r.root),
            txHash: r.tx_hash === null ? null : String(r.tx_hash),
          }
        : null;
    },

    async logKeeperRun(run: { job: string; target?: string | null; status: "ok" | "skipped" | "failed" | "dry_run"; detail?: unknown; txHash?: string | null }) {
      await db.query(`INSERT INTO keeper_run (job, target, status, detail, tx_hash) VALUES ($1, $2, $3, $4::jsonb, $5)`, [
        run.job,
        run.target ?? null,
        run.status,
        JSON.stringify(run.detail ?? {}, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
        run.txHash ?? null,
      ]);
    },

    async keeperRuns(limit: number) {
      return rows<Row>(db, `SELECT id, job, target, status, detail, tx_hash, created_at FROM keeper_run ORDER BY id DESC LIMIT $1`, [limit]);
    },
  };
}

export type AppStore = ReturnType<typeof createAppStore>;

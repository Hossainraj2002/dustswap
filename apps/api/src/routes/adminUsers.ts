import { Hono } from "hono";
import type { QueryResult, QueryResultRow } from "pg";
import { getDbPool } from "../lib/db";
import { swapFeeSql, sweepFeeSql, sweepGrossSql } from "../config/feeRates";

// These are the heaviest queries in the service and they share the pool that serves users.
// A runaway one would hold a connection until the pool starves and ordinary requests start
// dying at connectionTimeoutMillis, which is exactly the 2026-08-22 outage signature. Each
// admin query therefore runs on its own client inside a transaction with SET LOCAL
// statement_timeout, so Postgres kills it rather than letting it squat on a slot. SET LOCAL
// is scoped to the transaction, so the setting cannot leak to the next user of the connection.
const ADMIN_STATEMENT_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.ADMIN_USERS_STATEMENT_TIMEOUT_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 300_000) : 90_000;
})();

async function adminQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<QueryResult<T>> {
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${ADMIN_STATEMENT_TIMEOUT_MS}`);
    const result = await client.query<T>(text, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Admin user explorer. Read-only: every endpoint here SELECTs, nothing writes.
//
// Fee columns are derived, not stored. See config/feeRates.ts for why, and for the on-chain
// measurements the rates come from. The SQL fragments are shared with that module so this page
// can never drift from the numbers in the PP snapshot export.

const adminUsersRoutes = new Hono();

function getAdminToken() {
  const token = process.env.QUEST_ADMIN_TOKEN || process.env.PARTNER_ADMIN_TOKEN;
  if (!token) {
    throw new Error("QUEST_ADMIN_TOKEN is not configured");
  }
  return token;
}

function assertAdmin(c: any) {
  let expected: string;
  try {
    expected = getAdminToken();
  } catch {
    return c.json({ success: false, error: "Admin access is not configured" }, 503);
  }
  const received = c.req.header("x-admin-token");
  if (!received || received !== expected) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  return null;
}

const MAX_PAGE = 200;
const MAX_EXPORT = 100_000;
const MAX_IDENTIFIERS = 5_000;

// Sorting is limited to PP plus the fee/volume columns on purpose. Ordering the whole user
// table by spin or check-in count would mean aggregating millions of rows per request; those
// two ship as display columns, and the CSV export can be sorted on them offline.
type SortKey =
  | "pp_points"
  | "total_fees_paid_usd"
  | "swap_fees_paid_usd"
  | "sweep_fees_paid_usd"
  | "streak_save_fees_paid_usd"
  | "net_after_all_rewards_usd"
  | "swap_volume_usd"
  | "swap_count"
  | "sweep_count";

const SORTABLE: Record<SortKey, string> = {
  pp_points: "pp_points",
  total_fees_paid_usd: "total_fees_paid_usd",
  swap_fees_paid_usd: "swap_fees_paid_usd",
  sweep_fees_paid_usd: "sweep_fees_paid_usd",
  streak_save_fees_paid_usd: "streak_save_fees_paid_usd",
  net_after_all_rewards_usd: "net_after_all_rewards_usd",
  swap_volume_usd: "swap_volume_usd",
  swap_count: "swap_count",
  sweep_count: "sweep_count",
};

export type AdminUserFilters = {
  /** Free-form list: wallets, x handles, discord handles, or numeric user ids. */
  identifiers?: string[];
  /** Restrict how identifiers are matched. "auto" infers per entry. */
  identifierMode?: "auto" | "wallet" | "x" | "discord" | "user_id";
  ppMin?: number | null;
  ppMax?: number | null;
  hasX?: boolean | null;
  hasDiscord?: boolean | null;
  minTotalFees?: number | null;
  minSwapFees?: number | null;
  minSweepFees?: number | null;
  minStreakSaves?: number | null;
  minSwapCount?: number | null;
  minSweepCount?: number | null;
  /** Filters on users.last_check_in, which is a stored column, not a derived aggregate. */
  activeSince?: string | null;
  activeBefore?: string | null;
  /** ISO instant. Everything after it is ignored, so a run is reproducible. */
  asOf?: string | null;
  sort?: SortKey;
  direction?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean | null {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return null;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Split whatever the admin pasted into individual identifiers.
 *
 * Each line is kept whole AND split on whitespace. Wallets, handles and ids never contain a
 * space, but 3,591 Discord display names do, so splitting on whitespace alone would make
 * "Budson28 Arichain" unsearchable. Keeping both forms costs nothing: the whole-line variant
 * can only ever match a display name.
 */
export function parseIdentifiers(raw: unknown): string[] {
  const list: string[] = [];
  const push = (s: string) => {
    const v = s.trim().replace(/^@+/, "");
    if (v) list.push(v);
  };
  const addChunk = (chunk: string) => {
    push(chunk);
    if (/\s/.test(chunk.trim())) chunk.split(/\s+/).forEach(push);
  };
  const splitLines = (s: string) => s.split(/[\n\r,;]+/).forEach(addChunk);
  if (Array.isArray(raw)) {
    for (const item of raw) if (typeof item === "string") splitLines(String(item));
  } else if (typeof raw === "string") {
    splitLines(raw);
  }
  // de-duplicate case-insensitively, keep first spelling
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) {
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= MAX_IDENTIFIERS) break;
  }
  return out;
}

function normalizeFilters(body: any): AdminUserFilters {
  const sort = (SORTABLE as Record<string, string>)[body?.sort] ? (body.sort as SortKey) : "pp_points";
  return {
    identifiers: parseIdentifiers(body?.identifiers ?? body?.query),
    identifierMode: ["auto", "wallet", "x", "discord", "user_id"].includes(body?.identifierMode)
      ? body.identifierMode
      : "auto",
    ppMin: num(body?.ppMin),
    ppMax: num(body?.ppMax),
    hasX: bool(body?.hasX),
    hasDiscord: bool(body?.hasDiscord),
    minTotalFees: num(body?.minTotalFees),
    minSwapFees: num(body?.minSwapFees),
    minSweepFees: num(body?.minSweepFees),
    minStreakSaves: num(body?.minStreakSaves),
    minSwapCount: num(body?.minSwapCount),
    minSweepCount: num(body?.minSweepCount),
    activeSince: isoOrNull(body?.activeSince),
    activeBefore: isoOrNull(body?.activeBefore),
    asOf: isoOrNull(body?.asOf),
    sort,
    direction: body?.direction === "asc" ? "asc" : "desc",
    limit: Math.min(Math.max(Number(body?.limit) || 50, 1), MAX_PAGE),
    offset: Math.max(Number(body?.offset) || 0, 0),
  };
}

/** True when the request needs fees computed across the population, not just one page. */
function needsFeeWideScan(f: AdminUserFilters) {
  const feeSorts: SortKey[] = [
    "total_fees_paid_usd",
    "swap_fees_paid_usd",
    "sweep_fees_paid_usd",
    "streak_save_fees_paid_usd",
    "net_after_all_rewards_usd",
    "swap_volume_usd",
    "swap_count",
    "sweep_count",
  ];
  return (
    (f.minTotalFees ?? 0) > 0 ||
    (f.minSwapFees ?? 0) > 0 ||
    (f.minSweepFees ?? 0) > 0 ||
    (f.minStreakSaves ?? 0) > 0 ||
    (f.minSwapCount ?? 0) > 0 ||
    (f.minSweepCount ?? 0) > 0 ||
    feeSorts.includes(f.sort ?? "pp_points")
  );
}

/**
 * Build the full query. Everything user-supplied is parameterized; the only interpolated
 * values are the fee-rate literals from config and a whitelisted sort column.
 */
function buildQuery(f: AdminUserFilters, rowLimit: number, rowOffset: number) {
  const p: unknown[] = [];
  const add = (v: unknown) => `$${p.push(v)}`;

  const cutoff = f.asOf ?? new Date().toISOString();
  const pCut = add(cutoff);
  // check_ins / spin_history / streak / point_events store UTC in a naive timestamp column
  const naiveCut = `(${pCut}::timestamptz AT TIME ZONE 'UTC')`;

  const ids = f.identifiers ?? [];
  const hasIds = ids.length > 0;
  const mode = f.identifierMode ?? "auto";
  const lowered = ids.map((s) => s.toLowerCase());
  // Digits only. Number("0xebe0...") happily parses a wallet address as a hex integer and
  // yields something like 1.3e+48, which Postgres then rejects as an int.
  const numericIds = ids
    .filter((s) => /^\d+$/.test(s))
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 2147483647);

  const wantWallet = mode === "auto" || mode === "wallet";
  const wantX = mode === "auto" || mode === "x";
  const wantDiscord = mode === "auto" || mode === "discord";
  const wantUserId = mode === "auto" || mode === "user_id";

  // Only bind these when the SQL below actually references them: Postgres rejects a
  // parameter it never sees with "could not determine data type".
  const needLowered = hasIds && (wantWallet || wantX || wantDiscord);
  const needNumeric = hasIds && wantUserId;
  const pLowered = needLowered ? `${add(lowered)}::text[]` : "";
  const pNumeric = needNumeric ? `${add(numericIds.length ? numericIds : [0])}::int[]` : "";

  // Identifier matching. Wallet hits both the primary address and every linked wallet.
  const idMatch = hasIds
    ? `
    id_hits AS (
      ${wantWallet ? `SELECT id AS uid FROM users WHERE lower(address) = ANY(${pLowered})
        UNION SELECT user_id AS uid FROM user_wallets WHERE lower(wallet_address) = ANY(${pLowered})
        UNION` : ""}
      ${wantX ? `SELECT user_id AS uid FROM social_accounts WHERE platform='x' AND lower(username) = ANY(${pLowered})
        UNION SELECT id AS uid FROM users WHERE lower(x_username) = ANY(${pLowered})
        UNION` : ""}
      ${wantDiscord ? `SELECT user_id AS uid FROM social_accounts WHERE platform='discord'
          AND (lower(username) = ANY(${pLowered}) OR lower(display_name) = ANY(${pLowered}))
        UNION` : ""}
      ${needNumeric ? `SELECT id AS uid FROM users WHERE id = ANY(${pNumeric})` : `SELECT NULL::int AS uid WHERE false`}
    ),
    id_roots AS (SELECT DISTINCT c.root AS uid FROM id_hits h JOIN canon c ON c.uid = h.uid WHERE h.uid IS NOT NULL),`
    : "";

  const wide = needsFeeWideScan(f);
  // Fast path: plain PP browsing with no fee predicate. Pick the page of accounts first and
  // aggregate only those, instead of costing out fees for all 209k accounts to return 50 rows.
  const pageFirst = !hasIds && !wide;

  // Built twice, against two different parameter arrays: the count query is a separate
  // statement and Postgres rejects a bind that supplies more parameters than it references.
  const buildCheapPredicate = (bind: (v: unknown) => string) => `
            u.merged_into IS NULL
            ${f.ppMin != null ? `AND COALESCE(u.total_points,0) >= ${bind(f.ppMin)}` : ""}
            ${f.ppMax != null ? `AND COALESCE(u.total_points,0) <= ${bind(f.ppMax)}` : ""}
            ${f.activeSince ? `AND u.last_check_in >= ${bind(f.activeSince)}::timestamptz` : ""}
            ${f.activeBefore ? `AND u.last_check_in <= ${bind(f.activeBefore)}::timestamptz` : ""}
            ${f.hasX === true ? `AND (COALESCE(u.x_username,'') <> '' OR EXISTS (SELECT 1 FROM social_accounts s WHERE s.user_id=u.id AND s.platform='x'))` : ""}
            ${f.hasX === false ? `AND COALESCE(u.x_username,'') = '' AND NOT EXISTS (SELECT 1 FROM social_accounts s WHERE s.user_id=u.id AND s.platform='x')` : ""}
            ${f.hasDiscord === true ? `AND EXISTS (SELECT 1 FROM social_accounts s WHERE s.user_id=u.id AND s.platform='discord')` : ""}
            ${f.hasDiscord === false ? `AND NOT EXISTS (SELECT 1 FROM social_accounts s WHERE s.user_id=u.id AND s.platform='discord')` : ""}`;

  const cheapPredicate = buildCheapPredicate(add);

  const countParams: unknown[] = [];
  const addCount = (v: unknown) => `$${countParams.push(v)}`;
  const countSql = pageFirst
    ? `SELECT count(*)::bigint AS total FROM users u WHERE ${buildCheapPredicate(addCount)}`
    : null;

  // Candidate accounts. With identifiers we use exactly those. Otherwise, when a fee filter or
  // fee sort is in play we restrict to accounts that ever touched a paid product, because an
  // account with no activity has $0 of everything and cannot pass such a filter.
  const candidate = hasIds
    ? `cand AS (SELECT uid FROM id_roots)`
    : wide
      ? `cand AS (
          SELECT DISTINCT root AS uid FROM (
            SELECT c.root FROM swap_transactions t JOIN canon c ON c.uid = t.user_id
              WHERE t.occurred_at < ${pCut}::timestamptz
            UNION
            SELECT c.root FROM sweeps s
              JOIN addr_owner a ON a.addr = lower(s.user_address)
              JOIN canon c ON c.uid = a.uid
              WHERE s.created_at < ${pCut}::timestamptz
            UNION
            SELECT c.root FROM streak_recovery_events sr JOIN canon c ON c.uid = sr.user_id
              WHERE sr.status = 'confirmed' AND sr.created_at < ${naiveCut}
            UNION
            SELECT c.root FROM check_ins ci JOIN canon c ON c.uid = ci.user_id
              WHERE COALESCE(ci.payment_amount_usd,0) > 0 AND ci.created_at < ${naiveCut}
          ) z
        )`
      : `cand AS (
          SELECT u.id AS uid FROM users u
          WHERE ${cheapPredicate}
          ORDER BY COALESCE(u.total_points,0) ${f.direction === "asc" ? "ASC" : "DESC"}, u.id ASC
          LIMIT ${add(rowLimit)} OFFSET ${add(rowOffset)}
        )`;

  // Post-aggregation predicates
  const having: string[] = [];
  if (!pageFirst) {
    if (f.ppMin != null) having.push(`pp_points >= ${add(f.ppMin)}`);
    if (f.ppMax != null) having.push(`pp_points <= ${add(f.ppMax)}`);
    if (f.hasX === true) having.push(`x_name IS NOT NULL`);
    if (f.hasX === false) having.push(`x_name IS NULL`);
    if (f.hasDiscord === true) having.push(`discord_name IS NOT NULL`);
    if (f.hasDiscord === false) having.push(`discord_name IS NULL`);
    if (f.activeSince) having.push(`last_check_in >= ${add(f.activeSince)}::timestamptz`);
    if (f.activeBefore) having.push(`last_check_in <= ${add(f.activeBefore)}::timestamptz`);
  }
  if (f.minTotalFees != null) having.push(`total_fees_paid_usd >= ${add(f.minTotalFees)}`);
  if (f.minSwapFees != null) having.push(`swap_fees_paid_usd >= ${add(f.minSwapFees)}`);
  if (f.minSweepFees != null) having.push(`sweep_fees_paid_usd >= ${add(f.minSweepFees)}`);
  if (f.minStreakSaves != null) having.push(`streak_save_count >= ${add(f.minStreakSaves)}`);
  if (f.minSwapCount != null) having.push(`swap_count >= ${add(f.minSwapCount)}`);
  if (f.minSweepCount != null) having.push(`sweep_count >= ${add(f.minSweepCount)}`);

  const sortCol = SORTABLE[f.sort ?? "pp_points"];
  const dir = f.direction === "asc" ? "ASC" : "DESC";
  const pLimit = add(rowLimit);
  const pOffset = add(pageFirst ? 0 : rowOffset);

  const sql = `
WITH RECURSIVE m(uid, root, depth) AS (
  SELECT id, COALESCE(merged_into, id), 0 FROM users
  UNION ALL
  SELECT m.uid, COALESCE(u.merged_into, u.id), m.depth + 1
  FROM m JOIN users u ON u.id = m.root
  WHERE u.merged_into IS NOT NULL AND m.depth < 10
),
canon AS (SELECT DISTINCT ON (uid) uid, root FROM m ORDER BY uid, depth DESC),
addr_owner AS (
  SELECT addr, min(uid) AS uid FROM (
    SELECT lower(wallet_address) AS addr, user_id AS uid FROM user_wallets
    UNION ALL SELECT lower(address), id FROM users
  ) x GROUP BY addr
),
${idMatch}
${candidate},
swap_agg AS (
  SELECT c.root AS uid, count(*) AS swap_count, sum(t.amount_usd) AS swap_volume_usd,
         sum(${swapFeeSql("t")}) AS swap_fees_usd,
         min(t.occurred_at) AS first_at, max(t.occurred_at) AS last_at
  FROM swap_transactions t JOIN canon c ON c.uid = t.user_id
  WHERE c.root IN (SELECT uid FROM cand) AND t.occurred_at < ${pCut}::timestamptz
  GROUP BY 1
),
sweep_agg AS (
  SELECT c.root AS uid, count(*) AS sweep_count,
         sum(${sweepGrossSql("s", "cr")}) AS sweep_gross_usd,
         sum(${sweepFeeSql("s", "cr")}) AS sweep_fees_usd,
         min(s.created_at) AS first_at, max(s.created_at) AS last_at
  FROM sweeps s
  JOIN addr_owner a ON a.addr = lower(s.user_address)
  JOIN canon c ON c.uid = a.uid
  LEFT JOIN sweep_campaign_credits cr
    ON lower(cr.tx_hash) = lower(s.tx_hash) AND cr.chain_id = s.chain_id AND cr.status = 'verified'
  WHERE c.root IN (SELECT uid FROM cand) AND s.created_at < ${pCut}::timestamptz
  GROUP BY 1
),
streak_agg AS (
  SELECT c.root AS uid, count(*) AS streak_save_count, sum(sr.amount_usd) AS streak_save_fees_usd,
         min(sr.created_at) AS first_at, max(sr.created_at) AS last_at
  FROM streak_recovery_events sr JOIN canon c ON c.uid = sr.user_id
  WHERE sr.status = 'confirmed' AND c.root IN (SELECT uid FROM cand) AND sr.created_at < ${naiveCut}
  GROUP BY 1
),
checkin_agg AS (
  SELECT c.root AS uid, count(*) AS checkin_count,
         sum(CASE WHEN x.id IS NULL THEN COALESCE(ci.payment_amount_usd,0) ELSE 0 END) AS checkin_fees_usd,
         max(ci.created_at) AS last_at
  FROM check_ins ci JOIN canon c ON c.uid = ci.user_id
  LEFT JOIN streak_recovery_events x ON lower(x.tx_hash) = lower(ci.payment_tx_hash)
  WHERE c.root IN (SELECT uid FROM cand) AND ci.created_at < ${naiveCut}
  GROUP BY 1
),
spin_agg AS (
  SELECT c.root AS uid, count(*) AS spin_count,
         COALESCE(sum(sh.reward_points) FILTER (WHERE sh.status='confirmed'),0) AS spin_points_won,
         max(sh.created_at) AS last_at
  FROM spin_history sh JOIN canon c ON c.uid = sh.user_id
  WHERE c.root IN (SELECT uid FROM cand) AND sh.created_at < ${naiveCut}
  GROUP BY 1
),
campaign_agg AS (
  SELECT c.root AS uid,
         COALESCE(sum(cl.amount_usdc_micro) FILTER (WHERE cl.status='paid'),0)/1e6::numeric AS sweep_rewards_paid_usd,
         COALESCE(sum(cl.amount_usdc_micro) FILTER (WHERE cl.status='awaiting_claim'),0)/1e6::numeric AS sweep_rewards_pending_usd
  FROM sweep_campaign_claims cl JOIN canon c ON c.uid = cl.user_id
  WHERE c.root IN (SELECT uid FROM cand)
  GROUP BY 1
),
partner_agg AS (
  SELECT c.root AS uid, sum(d.payout_usdc_amount) FILTER (WHERE d.paid_at IS NOT NULL) AS partner_rewards_paid_usd
  FROM partner_reward_distributions d
  JOIN partner_program_members pm ON pm.id = d.partner_member_id
  JOIN canon c ON c.uid = pm.user_id
  WHERE c.root IN (SELECT uid FROM cand)
  GROUP BY 1
),
x_name AS (
  SELECT DISTINCT ON (user_id) user_id, username FROM social_accounts
  WHERE platform='x' AND COALESCE(username,'') <> '' ORDER BY user_id, id DESC
),
dc_name AS (
  SELECT DISTINCT ON (user_id) user_id, username, display_name FROM social_accounts
  WHERE platform='discord' AND COALESCE(username,'') <> '' ORDER BY user_id, id DESC
),
base_rows AS (
  SELECT
    u.id AS user_id,
    u.address AS wallet,
    COALESCE(xn.username, NULLIF(u.x_username,'')) AS x_name,
    dc.username AS discord_name,
    dc.display_name AS discord_display_name,
    COALESCE(u.total_points,0)::bigint AS pp_points,
    COALESCE(u.current_streak,0) AS current_streak,
    u.last_check_in AS last_check_in,
    COALESCE(sw.swap_count,0)::bigint AS swap_count,
    round(COALESCE(sw.swap_volume_usd,0),2) AS swap_volume_usd,
    round(COALESCE(sw.swap_fees_usd,0),4) AS swap_fees_paid_usd,
    COALESCE(sp.sweep_count,0)::bigint AS sweep_count,
    round(COALESCE(sp.sweep_gross_usd,0),2) AS sweep_gross_usd,
    round(COALESCE(sp.sweep_fees_usd,0),4) AS sweep_fees_paid_usd,
    round(COALESCE(ca.sweep_rewards_paid_usd,0),2) AS sweep_rewards_received_usd,
    round(COALESCE(ca.sweep_rewards_pending_usd,0),2) AS sweep_rewards_pending_usd,
    round(COALESCE(sp.sweep_fees_usd,0) - COALESCE(ca.sweep_rewards_paid_usd,0),4) AS sweep_fees_net_of_rewards_usd,
    COALESCE(st.streak_save_count,0)::bigint AS streak_save_count,
    round(COALESCE(st.streak_save_fees_usd,0),2) AS streak_save_fees_paid_usd,
    COALESCE(ck.checkin_count,0)::bigint AS checkin_count,
    round(COALESCE(ck.checkin_fees_usd,0),2) AS checkin_fees_paid_usd,
    COALESCE(sn.spin_count,0)::bigint AS spin_count,
    COALESCE(sn.spin_points_won,0)::bigint AS spin_points_won,
    round(COALESCE(pa.partner_rewards_paid_usd,0),4) AS partner_rewards_received_usd,
    round(COALESCE(sw.swap_fees_usd,0) + COALESCE(sp.sweep_fees_usd,0)
          + COALESCE(st.streak_save_fees_usd,0) + COALESCE(ck.checkin_fees_usd,0),4) AS total_fees_paid_usd,
    round(COALESCE(ca.sweep_rewards_paid_usd,0) + COALESCE(pa.partner_rewards_paid_usd,0),4) AS total_rewards_received_usd,
    round(COALESCE(sw.swap_fees_usd,0) + COALESCE(sp.sweep_fees_usd,0)
          + COALESCE(st.streak_save_fees_usd,0) + COALESCE(ck.checkin_fees_usd,0)
          - COALESCE(ca.sweep_rewards_paid_usd,0) - COALESCE(pa.partner_rewards_paid_usd,0),4) AS net_after_all_rewards_usd,
    GREATEST(sw.last_at, sp.last_at, st.last_at::timestamptz, ck.last_at::timestamptz, sn.last_at::timestamptz)::date AS last_activity
  FROM cand
  JOIN users u ON u.id = cand.uid
  LEFT JOIN swap_agg sw ON sw.uid = cand.uid
  LEFT JOIN sweep_agg sp ON sp.uid = cand.uid
  LEFT JOIN streak_agg st ON st.uid = cand.uid
  LEFT JOIN checkin_agg ck ON ck.uid = cand.uid
  LEFT JOIN spin_agg sn ON sn.uid = cand.uid
  LEFT JOIN campaign_agg ca ON ca.uid = cand.uid
  LEFT JOIN partner_agg pa ON pa.uid = cand.uid
  LEFT JOIN x_name xn ON xn.user_id = cand.uid
  LEFT JOIN dc_name dc ON dc.user_id = cand.uid
),
filtered AS (
  SELECT * FROM base_rows
  ${having.length ? `WHERE ${having.join(" AND ")}` : ""}
)
SELECT *, count(*) OVER () AS total_matches
FROM filtered
ORDER BY ${sortCol} ${dir} NULLS LAST, user_id ASC
LIMIT ${pLimit} OFFSET ${pOffset}`;

  return { sql, params: p, cutoff, countSql, countParams, pageFirst };
}

adminUsersRoutes.post("/search", async (c) => {
  const authError = assertAdmin(c);
  if (authError) return authError;

  const body = await c.req.json().catch(() => ({}));
  const f = normalizeFilters(body);
  const { sql, params, cutoff, countSql, countParams, pageFirst } = buildQuery(f, f.limit ?? 50, f.offset ?? 0);

  const startedAt = Date.now();
  try {
    // In page-first mode `cand` is already one page, so count(*) OVER () would only ever report
    // the page size. The real total comes from the same cheap predicate, counted separately.
    const [result, countResult] = await Promise.all([
      adminQuery(sql, params),
      countSql ? adminQuery(countSql, countParams) : Promise.resolve(null),
    ]);
    const total = pageFirst
      ? Number((countResult?.rows?.[0] as any)?.total ?? 0)
      : result.rows.length
        ? Number((result.rows[0] as any).total_matches)
        : 0;
    const rows = result.rows.map((r: any) => {
      const { total_matches, ...rest } = r;
      return rest;
    });
    c.header("Cache-Control", "no-store, max-age=0");
    return c.json({
      success: true,
      data: {
        rows,
        total,
        limit: f.limit,
        offset: f.offset,
        asOf: cutoff,
        tookMs: Date.now() - startedAt,
        identifiersParsed: f.identifiers?.length ?? 0,
      },
    });
  } catch (error) {
    console.error("[admin/users/search]", error);
    return c.json({ success: false, error: (error as Error).message }, 500);
  }
});

function csvEscape(v: unknown) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

adminUsersRoutes.post("/export", async (c) => {
  const authError = assertAdmin(c);
  if (authError) return authError;

  const body = await c.req.json().catch(() => ({}));
  const f = normalizeFilters(body);
  const limit = Math.min(Math.max(Number(body?.limit) || MAX_EXPORT, 1), MAX_EXPORT);
  const { sql, params, cutoff } = buildQuery(f, limit, 0);

  try {
    const result = await adminQuery(sql, params);
    const cols = result.fields.map((x) => x.name).filter((n) => n !== "total_matches");
    const lines = [cols.join(",")];
    for (const row of result.rows as any[]) {
      lines.push(cols.map((k) => csvEscape(row[k])).join(","));
    }
    // BOM so Excel reads non-ASCII handles correctly
    const csv = "﻿" + lines.join("\n");
    const stamp = cutoff.slice(0, 10);
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="dustswap-users-${stamp}.csv"`);
    c.header("Cache-Control", "no-store, max-age=0");
    return c.body(csv);
  } catch (error) {
    console.error("[admin/users/export]", error);
    return c.json({ success: false, error: (error as Error).message }, 500);
  }
});

/** Totals across everything, so the page can show what the filters are a slice of. */
adminUsersRoutes.get("/summary", async (c) => {
  const authError = assertAdmin(c);
  if (authError) return authError;
  try {
    const { rows } = await adminQuery(`
      SELECT
        (SELECT count(*) FROM users WHERE merged_into IS NULL) AS accounts,
        (SELECT count(*) FROM users WHERE merged_into IS NOT NULL) AS merged_accounts,
        (SELECT count(*) FROM social_accounts WHERE platform='x') AS x_linked,
        (SELECT count(*) FROM social_accounts WHERE platform='discord') AS discord_linked,
        (SELECT count(*) FROM swap_transactions) AS swaps,
        (SELECT count(*) FROM sweeps) AS sweeps,
        (SELECT count(*) FROM streak_recovery_events WHERE status='confirmed') AS streak_saves,
        (SELECT round(sum(${swapFeeSql("t")}),2) FROM swap_transactions t) AS swap_fees_usd,
        (SELECT round(sum(${sweepFeeSql("s", "cr")}),2) FROM sweeps s
           LEFT JOIN sweep_campaign_credits cr
             ON lower(cr.tx_hash)=lower(s.tx_hash) AND cr.chain_id=s.chain_id AND cr.status='verified') AS sweep_fees_usd,
        (SELECT round(sum(amount_usd),2) FROM streak_recovery_events WHERE status='confirmed') AS streak_fees_usd,
        -- historical $0.01 paid check-ins and footprint claims; both fees are 0 today.
        -- Streak Save payments are mirrored into check_ins, so exclude them by tx hash.
        (SELECT round(COALESCE(sum(ci.payment_amount_usd),0),2)
           FROM check_ins ci
           LEFT JOIN streak_recovery_events sr ON lower(sr.tx_hash) = lower(ci.payment_tx_hash)
          WHERE COALESCE(ci.payment_amount_usd,0) > 0 AND sr.id IS NULL) AS checkin_fees_usd,
        (SELECT round(COALESCE(sum((metadata->>'paymentAmountUsd')::numeric),0),2)
           FROM point_events
          WHERE action='footprint_airdrop_claim'
            AND COALESCE((metadata->>'paymentAmountUsd')::numeric,0) > 0) AS footprint_fees_usd
    `);
    c.header("Cache-Control", "no-store, max-age=0");
    return c.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error("[admin/users/summary]", error);
    return c.json({ success: false, error: (error as Error).message }, 500);
  }
});

export { adminUsersRoutes };

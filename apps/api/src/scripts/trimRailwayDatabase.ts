import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

/**
 * Shrinks the Railway database by clearing history tables that nothing in the app reads.
 *
 * Why TRUNCATE and not DELETE: TRUNCATE drops the underlying files and returns the disk
 * immediately. DELETE leaves the space inside the file and then needs VACUUM FULL, which takes an
 * exclusive lock and temporarily needs twice the table size free.
 *
 * DRY RUN BY DEFAULT. Pass --confirm to actually write.
 *
 * Usage:
 *   ts-node src/scripts/trimRailwayDatabase.ts                 # report only
 *   ts-node src/scripts/trimRailwayDatabase.ts --confirm       # do it
 *   ts-node src/scripts/trimRailwayDatabase.ts --confirm --zero-points
 */

/**
 * Cleared. Every one of these is an append-only log or a regenerable cache. Checked against the
 * codebase first: none of them is the source of truth for a balance or for any state the app
 * reads back.
 */
const WIPE = [
  "point_events", // 4.2 GB. Audit log. The balance lives in users.total_points.
  "spin_history", // 1.1 GB. Log. Tickets live in wallet_spin_balances.
  "activity_events", // 486 MB. Log.
  "swap_transactions", // 608 MB. Per-swap rows. Totals survive in user_volume_alltime.
  "sweep_history", // 212 MB. Log.
  "sweeps", // Log.
  "dustsweep_token_cache", // 183 MB. Pure cache, refills itself.
  "dustsweep_routeability_cache", // Cache.
  "quest_verification_logs", // 87 MB. Log.
  "oauth_states", // 60 MB. Transient login handshakes.
  "user_onboarding_guides", // 17 MB. UI progress.
  "user_volume_daily", // 13 MB. Daily rollup; the all-time table is kept.
  "notification_sends", // 6 MB. Send log.
  "notification_runs",
  "wallet_discovery_jobs",
  "token_quote_cache",
  "wallet_token_balances",
];

/**
 * Dead tables left behind by July 2026 migrations. Dropped outright rather than emptied.
 */
const DROP = [
  "sweep_history_dedupe_backup_20260708",
  "uvd_full_backup_20260707",
  "uvd_fix_backup_20260707",
  "uva_full_backup_20260707",
  "uva_fix_backup_20260707",
  "clawback_qp_backup_20260707",
  "clawback_users_backup_20260707",
  "swap_usd_fix_backup_20260707",
  "sweephist_fix_backup_20260707",
  "activityev_fix_backup_20260707",
  "dedup_users_backup_20260707",
  "invalid_wallet_rows_backup_20260708",
  "invalid_users_quarantine_backup_20260708",
  "invalid_user_referrals_backup_20260708",
  "merged_user_points_cleanup_backup_20260708",
  "referral_user_referred_by_backup_20260708",
];

/**
 * Kept on purpose, with the reason. Anything not listed in WIPE or DROP is kept anyway; this list
 * exists so the load-bearing ones are documented rather than left to memory.
 *
 *   users, user_wallets, social_accounts, user_profiles  identity
 *   referrals, account_merges, wallet_link_requests      identity graph
 *   quest_progress    NOT a log. /api/quests is still mounted with no kill switch, so clearing
 *                     this would let every user re-complete every quest and re-earn points.
 *   check_ins         stops a second check-in on the same day being credited again
 *   wallet_spin_balances   spin tickets people own
 *   streak_recovery_events, sweep_campaign_credits, sweep_campaign_claims,
 *   partner_reward_distributions, partner_fee_share_history, airdrop_allocations
 *                     records of real money in and out. Under 6 MB combined.
 *   user_volume_alltime    keeps lifetime volume after swap_transactions is cleared
 *   quests, chain_registry, tokens, daily_asset_prices, token_price_cache_daily   config
 */

function parseArgs(argv: string[]) {
  return {
    confirm: argv.includes("--confirm"),
    zeroPoints: argv.includes("--zero-points"),
  };
}

/** Refuses to run against a database with no recent local backup. */
function assertFreshBackup() {
  const dir = "C:/Users/akbar/dustswap-backup";
  if (!fs.existsSync(dir)) throw new Error(`No backup directory at ${dir}`);

  const dumps = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("railway-full-") && f.endsWith(".dump"))
    .map((f) => ({ f, ...fs.statSync(path.join(dir, f)) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (dumps.length === 0) throw new Error("No railway-full-*.dump found. Take a backup first.");

  const newest = dumps[0];
  const ageHours = (Date.now() - newest.mtimeMs) / 3_600_000;
  const sizeMb = newest.size / 1_048_576;

  console.log(`backup   ${newest.f}  ${sizeMb.toFixed(1)} MB  ${ageHours.toFixed(1)}h old`);

  if (ageHours > 24) throw new Error(`Newest backup is ${ageHours.toFixed(1)}h old. Take a fresh one.`);
  if (sizeMb < 100) throw new Error(`Newest backup is only ${sizeMb.toFixed(1)} MB. That looks wrong.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertFreshBackup();

  const conn = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!conn) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL must be set");

  const client = new Client({ connectionString: conn });
  await client.connect();

  try {
    const sizeBefore = await client.query<{ s: string; b: string }>(
      "SELECT pg_size_pretty(pg_database_size(current_database())) s, pg_database_size(current_database())::text b"
    );
    console.log(`database ${sizeBefore.rows[0].s} before\n`);

    // Only touch tables that actually exist, so a rename upstream cannot fail the run.
    const existing = new Set(
      (
        await client.query<{ t: string }>(
          "SELECT tablename t FROM pg_tables WHERE schemaname='public'"
        )
      ).rows.map((r) => r.t)
    );

    const toWipe = WIPE.filter((t) => existing.has(t));
    const toDrop = DROP.filter((t) => existing.has(t));

    const sized = await client.query<{ t: string; pretty: string; bytes: string }>(
      `SELECT c.relname t, pg_size_pretty(pg_total_relation_size(c.oid)) pretty,
              pg_total_relation_size(c.oid)::text bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname = ANY($1::text[])
        ORDER BY pg_total_relation_size(c.oid) DESC`,
      [[...toWipe, ...toDrop]]
    );

    let reclaim = 0n;
    for (const r of sized.rows) {
      const action = toDrop.includes(r.t) ? "DROP " : "CLEAR";
      console.log(`  ${action}  ${r.t.padEnd(38)} ${r.pretty}`);
      reclaim += BigInt(r.bytes);
    }
    console.log(`\nreclaims ${(Number(reclaim) / 1_048_576).toFixed(0)} MB`);

    const pointsRow = await client.query<{ n: string; total: string }>(
      "SELECT count(*) n, coalesce(sum(total_points),0)::text total FROM users WHERE total_points > 0"
    );
    console.log(
      `points   ${Number(pointsRow.rows[0].n).toLocaleString()} accounts hold ` +
        `${Number(pointsRow.rows[0].total).toLocaleString()} points` +
        (args.zeroPoints ? "  -> will be set to 0" : "  (left alone, pass --zero-points)")
    );

    if (!args.confirm) {
      console.log("\nDRY RUN. Nothing was changed. Re-run with --confirm to apply.");
      return;
    }

    console.log("\napplying...");
    await client.query("BEGIN");

    if (toWipe.length > 0) {
      // One statement so foreign keys between these tables cannot block each other.
      const list = toWipe.map((t) => `public."${t}"`).join(", ");
      await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY`);
      console.log(`  cleared ${toWipe.length} tables`);
    }

    for (const t of toDrop) {
      await client.query(`DROP TABLE IF EXISTS public."${t}"`);
    }
    if (toDrop.length > 0) console.log(`  dropped ${toDrop.length} dead migration tables`);

    if (args.zeroPoints) {
      const res = await client.query("UPDATE users SET total_points = 0 WHERE total_points <> 0");
      console.log(`  zeroed points on ${res.rowCount?.toLocaleString()} accounts`);
    }

    await client.query("COMMIT");
    console.log("  committed");

    // Planner stats are meaningless after this much churn.
    await client.query("ANALYZE");
    console.log("  analyzed");

    const after = await client.query<{ s: string }>(
      "SELECT pg_size_pretty(pg_database_size(current_database())) s"
    );
    console.log(`\ndatabase ${sizeBefore.rows[0].s} -> ${after.rows[0].s}`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});

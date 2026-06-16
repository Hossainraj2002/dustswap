// One-off: apply the wallet-merge migration to the configured database.
// Runs ONLY wallet_merge.sql (additive) then wallet_merge_constraints.sql
// (constraint swap). Idempotent. Reads the connection string from the API
// .env.local (prefers DATABASE_PUBLIC_URL so it works from outside Railway).
//
// Usage (from apps/api): npx ts-node src/scripts/applyWalletMerge.ts
import { Client } from "pg";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const url =
  process.env.APPLY_DATABASE_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  process.env.DATABASE_URL ||
  "";

if (!url) {
  console.error("No database URL found (DATABASE_PUBLIC_URL / DATABASE_URL).");
  process.exit(1);
}

const apiRoot = path.resolve(__dirname, "../..");
const files = ["sql/wallet_merge.sql", "sql/wallet_merge_constraints.sql"];

function needsSsl(connectionString: string) {
  try {
    const host = new URL(connectionString).hostname.toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return true;
  }
}

async function main() {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "unknown";
    }
  })();

  const client = new Client({
    connectionString: url,
    ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  console.log(`Connected to ${host}`);

  for (const rel of files) {
    const full = path.join(apiRoot, rel);
    const sql = fs.readFileSync(full, "utf8");
    process.stdout.write(`Applying ${rel} ... `);
    await client.query(sql);
    console.log("ok");
  }

  // Read-only verification.
  const checks = await client.query(`
    SELECT
      to_regclass('public.user_wallets')         IS NOT NULL AS has_user_wallets,
      to_regclass('public.wallet_spin_balances') IS NOT NULL AS has_spin_balances,
      to_regclass('public.wallet_link_requests') IS NOT NULL AS has_link_requests,
      to_regclass('public.account_merges')       IS NOT NULL AS has_account_merges,
      to_regprocedure('public.resolve_user_by_wallet(text)')           IS NOT NULL AS has_resolve_fn,
      to_regprocedure('public.merge_accounts(integer,integer,character varying,bigint,integer)') IS NOT NULL AS has_merge_fn,
      (SELECT COUNT(*) FROM users)         AS users_count,
      (SELECT COUNT(*) FROM user_wallets)  AS user_wallets_count,
      (SELECT COUNT(*) FROM wallet_spin_balances) AS spin_balance_count,
      EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_quest_progress_account') AS has_account_idx,
      EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_quest_progress_wallet')  AS has_wallet_idx,
      EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'quest_progress_user_id_quest_id_cycle_key_key'
      ) AS old_quest_unique_still_present
  `);

  console.log("Verification:", JSON.stringify(checks.rows[0], null, 2));

  await client.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});

// Loads the full DustSwap schema into a LOCAL database for development/testing.
// Never point this at production. Usage (PowerShell):
//   $env:LOCAL_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"; npx ts-node src/scripts/setupLocalDb.ts
// Usage (bash):
//   LOCAL_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npx ts-node src/scripts/setupLocalDb.ts
import { Client } from "pg";
import fs from "fs";
import path from "path";

const url = process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL || "";
if (!url) {
  console.error("Set LOCAL_DATABASE_URL (or DATABASE_URL) to a LOCAL Postgres.");
  process.exit(1);
}
if (/railway|supabase|\.proxy\.|amazonaws|neon\.tech/i.test(url) && !process.env.ALLOW_REMOTE_SETUP) {
  console.error(
    "Refusing to run: the URL looks remote. This script is for local dev DBs only.\n" +
      "If you really mean it, set ALLOW_REMOTE_SETUP=1."
  );
  process.exit(1);
}

const apiRoot = path.resolve(__dirname, "../..");
// Order matters: base schema first, feature tables next, wallet_merge last.
const files = [
  "src/schema.sql",
  "sql/swap_volume_schema.sql",
  "sql/swap_volume_rpc.sql",
  "sql/multichain_swap_capture.sql",
  "sql/swap_token_price_cache.sql",
  "sql/swap_volume_write_guard.sql",
  "sql/recent_trader_wallets_72h.sql",
  "sql/referral_leaderboard_min_invites.sql",
  "sql/referral_leaderboard_snapshot_fix.sql",
  "sql/profile_completion_guide.sql",
  "sql/partner_program.sql",
  "sql/partner_program_swap_value_cap.sql",
  "sql/partner_content_submissions.sql",
  "sql/spin_feature.sql",
  "sql/x_oauth_getx_verification.sql",
  "sql/user_profiles.sql",
  "sql/wallet_merge.sql",
  "sql/wallet_merge_constraints.sql",
  "sql/admin_wallet_replacement.sql",
];

async function main() {
  const client = new Client({ connectionString: url });
  await client.connect();
  console.log(`Connected to ${new URL(url).host}`);

  for (const rel of files) {
    const full = path.join(apiRoot, rel);
    if (!fs.existsSync(full)) {
      console.warn(`  skip (missing): ${rel}`);
      continue;
    }
    const sql = fs.readFileSync(full, "utf8");
    try {
      await client.query(sql);
      console.log(`  ok: ${rel}`);
    } catch (err) {
      // Continue on error so ordering/feature gaps don't abort the whole setup.
      console.warn(`  warn: ${rel} -> ${(err as Error).message}`);
    }
  }

  await client.end();
  console.log("Local schema setup complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

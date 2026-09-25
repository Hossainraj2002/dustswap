import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

/**
 * Loads a built allocation into Postgres as the record of what the airdrop pays.
 *
 * Additive and idempotent. It creates one new table and writes one labelled snapshot into it;
 * it never reads, updates or deletes anything else. Re-running with the same --snapshot replaces
 * only that snapshot's rows, so a rebuilt list can be pushed again without leaving duplicates.
 *
 * Usage:
 *   ts-node src/scripts/saveClaimAllocation.ts \
 *     --dir "C:/Users/akbar/dustswap-reports/claim" \
 *     --snapshot 2026-09-24
 *
 * Flags:
 *   --dir <path>       Directory written by buildClaimAllocation.ts. Required.
 *   --snapshot <label> Label for this version of the list. Required.
 *   --dry-run          Parse and report, write nothing.
 */

type Row = {
  idx: number;
  userId: number | null;
  address: string;
  amountUsdc: string;
  amountBaseUnits: string;
  prorataUsdc: string;
  bonusUsdc: string;
  communityMember: boolean;
  origin: string;
  note: string;
  sweepVolumeUsd: string;
  swapVolumeUsd: string;
  streakSaves: number;
};

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const split = (line: string) => {
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
      } else if (ch === "," && !quoted) {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    return cells;
  };
  return { header: split(lines[0]), rows: lines.slice(1).map(split) };
}

const DDL = `
CREATE TABLE IF NOT EXISTS airdrop_allocations (
  id                BIGSERIAL PRIMARY KEY,
  snapshot          TEXT NOT NULL,
  merkle_root       TEXT NOT NULL,
  idx               INTEGER NOT NULL,
  user_id           INTEGER,
  address           TEXT NOT NULL,
  amount_usdc       NUMERIC(18,6) NOT NULL,
  amount_base_units BIGINT NOT NULL,
  prorata_usdc      NUMERIC(18,6) NOT NULL DEFAULT 0,
  bonus_usdc        NUMERIC(18,6) NOT NULL DEFAULT 0,
  community_member  BOOLEAN NOT NULL DEFAULT FALSE,
  origin            TEXT NOT NULL,
  note              TEXT,
  sweep_volume_usd  NUMERIC(18,2),
  swap_volume_usd   NUMERIC(18,2),
  streak_saves      INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS airdrop_allocations_snapshot_address
  ON airdrop_allocations (snapshot, lower(address));
CREATE INDEX IF NOT EXISTS airdrop_allocations_snapshot_idx
  ON airdrop_allocations (snapshot, idx);
CREATE INDEX IF NOT EXISTS airdrop_allocations_user
  ON airdrop_allocations (user_id);
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = String(args.dir || "");
  const snapshot = String(args.snapshot || "");
  const dryRun = Boolean(args["dry-run"]);

  if (!dir || !fs.existsSync(dir)) throw new Error("--dir must point at a built allocation");
  if (!snapshot) throw new Error("--snapshot is required");

  const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
  const { header, rows: raw } = parseCsv(fs.readFileSync(path.join(dir, "allocation.csv"), "utf8"));
  const col = (n: string) => {
    const i = header.indexOf(n);
    if (i < 0) throw new Error(`allocation.csv is missing ${n}`);
    return i;
  };

  const c = {
    idx: col("index"),
    userId: col("user_id"),
    address: col("address"),
    amountUsdc: col("amount_usdc"),
    amountBase: col("amount_base_units"),
    prorata: col("prorata_usdc"),
    bonus: col("bonus_usdc"),
    community: col("community_member"),
    origin: col("origin"),
    note: col("note"),
    sweep: col("sweep_gross_usd"),
    swap: col("swap_volume_usd"),
    streak: col("streak_save_count"),
  };

  const rows: Row[] = raw.map((r) => ({
    idx: Number(r[c.idx]),
    // Hand-added rows carry a synthetic negative id, which is not a real account.
    userId: Number(r[c.userId]) > 0 ? Number(r[c.userId]) : null,
    address: r[c.address].trim().toLowerCase(),
    amountUsdc: r[c.amountUsdc],
    amountBaseUnits: r[c.amountBase],
    prorataUsdc: r[c.prorata],
    bonusUsdc: r[c.bonus],
    communityMember: r[c.community] === "yes",
    origin: r[c.origin],
    note: r[c.note],
    sweepVolumeUsd: r[c.sweep],
    swapVolumeUsd: r[c.swap],
    streakSaves: Number(r[c.streak] || 0),
  }));

  for (const r of rows) {
    if (!/^0x[0-9a-f]{40}$/.test(r.address)) throw new Error(`Bad address: ${r.address}`);
    if (!Number.isInteger(r.idx) || r.idx < 0) throw new Error(`Bad index on ${r.address}`);
  }

  const totalBase = rows
    .filter((r, i, a) => a.findIndex((x) => x.idx === r.idx) === i)
    .reduce((s, r) => s + BigInt(r.amountBaseUnits), 0n);

  if (totalBase.toString() !== summary.totalAllocationBaseUnits) {
    throw new Error(
      `CSV sums to ${totalBase}, summary says ${summary.totalAllocationBaseUnits}. Refusing to write.`
    );
  }

  console.log(`snapshot        ${snapshot}`);
  console.log(`root            ${summary.root}`);
  console.log(`address rows    ${rows.length}`);
  console.log(`accounts        ${new Set(rows.map((r) => r.idx)).size}`);
  console.log(`total           ${summary.totalAllocationUsd} USDC`);
  console.log(`community       ${rows.filter((r) => r.communityMember).length} rows`);

  if (dryRun) {
    console.log("\n--dry-run, nothing written.");
    return;
  }

  const conn = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!conn) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL must be set");

  const client = new Client({ connectionString: conn });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(DDL);

    const cleared = await client.query("DELETE FROM airdrop_allocations WHERE snapshot = $1", [
      snapshot,
    ]);
    if (cleared.rowCount) console.log(`replaced ${cleared.rowCount} existing rows for this snapshot`);

    const COLUMNS = 15;
    const CHUNK = 500;
    let written = 0;

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const tuples: string[] = [];

      chunk.forEach((r, j) => {
        values.push(
          snapshot,
          summary.root,
          r.idx,
          r.userId,
          r.address,
          r.amountUsdc,
          r.amountBaseUnits,
          r.prorataUsdc,
          r.bonusUsdc,
          r.communityMember,
          r.origin,
          r.note || null,
          r.sweepVolumeUsd,
          r.swapVolumeUsd,
          r.streakSaves
        );
        const base = j * COLUMNS;
        tuples.push(
          `(${Array.from({ length: COLUMNS }, (_, k) => `$${base + k + 1}`).join(",")})`
        );
      });

      await client.query(
        `INSERT INTO airdrop_allocations
           (snapshot, merkle_root, idx, user_id, address, amount_usdc, amount_base_units,
            prorata_usdc, bonus_usdc, community_member, origin, note,
            sweep_volume_usd, swap_volume_usd, streak_saves)
         VALUES ${tuples.join(",")}`,
        values
      );
      written += chunk.length;
      process.stdout.write(`\rwrote ${written}/${rows.length}`);
    }
    console.log("");

    const check = await client.query<{ n: string; total: string; accounts: string }>(
      `SELECT count(*) AS n,
              (SELECT sum(amount_base_units) FROM (
                 SELECT DISTINCT ON (idx) idx, amount_base_units
                 FROM airdrop_allocations WHERE snapshot = $1 ORDER BY idx
               ) d) AS total,
              count(DISTINCT idx) AS accounts
       FROM airdrop_allocations WHERE snapshot = $1`,
      [snapshot]
    );

    const got = check.rows[0];
    if (got.total !== summary.totalAllocationBaseUnits) {
      throw new Error(`Stored total ${got.total} does not match ${summary.totalAllocationBaseUnits}`);
    }

    await client.query("COMMIT");
    console.log(`\nstored rows     ${got.n}`);
    console.log(`stored accounts ${got.accounts}`);
    console.log(`stored total    ${got.total} base units (verified)`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

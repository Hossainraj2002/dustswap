import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

/**
 * Turns the frozen Particle Points close-out list into a Merkle allocation that
 * `DustSwapRewardDistributor` can pay out.
 *
 * The tree construction here is mirrored field for field by the helpers in
 * `packages/contracts/test/DustSwapRewardDistributor.t.sol`:
 *
 *   leaf   = keccak256(keccak256(abi.encode(uint256 index, address account, uint256 amount)))
 *   order  = leaves sorted ascending by hash, so the root does not depend on input order
 *   parent = keccak256(sorted(left, right)), an odd trailing node promoted unchanged
 *
 * Nothing here touches the database except one read of `user_wallets`, and nothing is written
 * anywhere inside the repository unless --out points there.
 *
 * Usage:
 *   ts-node src/scripts/buildClaimAllocation.ts \
 *     --csv "C:/Users/akbar/Downloads/dustswap-users-2026-09-22.csv" \
 *     --budget 20000 \
 *     --basis fees \
 *     --out "C:/Users/akbar/dustswap-reports/claim"
 *
 * Flags:
 *   --csv <path>      The frozen eligibility export. Required.
 *   --budget <usd>    Total to distribute. Default 20000.
 *   --basis fees|net  Pro-rata weight. `fees` uses total_fees_paid_usd, `net` uses
 *                     net_after_all_rewards_usd floored at zero. Default `fees`.
 *   --min <usd>       Drop any account whose allocation lands below this. Default 0.
 *   --out <dir>       Output directory. Default C:/Users/akbar/dustswap-reports/claim.
 *   --no-db           Skip the linked-wallet expansion (single address per account).
 *   --as-of <iso>     Cutoff for hand-added accounts activity lookup.
 *                     Default 2026-09-21T16:30:00.000Z, the snapshot cutoff.
 *   --manual <path>   CSV of hand-added recipients, see below.
 *   --exclude <path>  CSV of `address` or `user_id` values to drop from the list.
 *
 * Hand-added recipients (--manual)
 * --------------------------------
 * A CSV with a header row. Recognised columns, all optional except one identifier:
 *
 *   address      0x... payout address. Use this OR user_id.
 *   user_id      An existing DustSwap account id. Its wallets are looked up and the
 *                allocation goes to the account's own address.
 *   amount_usd   A fixed grant. Taken off the top of the budget before pro-rata.
 *   weight_usd   Instead of a fixed grant, join the pro-rata pool with this weight, as if
 *                the account had paid this much in fees.
 *   note         Free text, carried into allocation.csv for the audit trail.
 *
 * Example:
 *   address,amount_usd,note
 *   0x1234...,25,discord moderator
 *   ,,
 *   user_id,weight_usd,note
 *   182056,40,missed by the snapshot
 *
 * Fixed grants are honoured exactly and the REMAINING budget is shared pro-rata across
 * everyone else, so the total always lands on --budget to the base unit. An address already
 * on the main list is updated in place rather than duplicated, and the script says so.
 */

const USDC_DECIMALS = 6;
const DEFAULT_OUT = "C:/Users/akbar/dustswap-reports/claim";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
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

/** Minimal RFC 4180 reader. The export quotes any field containing a comma. */
function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.length > 0);
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
        } else {
          quoted = !quoted;
        }
      } else if (ch === "," && !quoted) {
        cells.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells;
  };
  return { header: split(lines[0]), rows: lines.slice(1).map(split) };
}

// ---------------------------------------------------------------------------------------------
// Merkle
// ---------------------------------------------------------------------------------------------

function leafHash(index: number, account: Hex, amount: bigint): Hex {
  const encoded = encodeAbiParameters(parseAbiParameters("uint256, address, uint256"), [
    BigInt(index),
    account,
    amount,
  ]);
  return keccak256(keccak256(encoded));
}

function hashPair(a: Hex, b: Hex): Hex {
  const [lo, hi] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(`0x${lo.slice(2)}${hi.slice(2)}` as Hex);
}

/** Builds every level bottom up. Level 0 is the sorted leaves. */
function buildLevels(sortedLeaves: Hex[]): Hex[][] {
  const levels: Hex[][] = [sortedLeaves];
  let level = sortedLeaves;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    levels.push(next);
    level = next;
  }
  return levels;
}

function proofFor(levels: Hex[][], position: number): Hex[] {
  const proof: Hex[] = [];
  let pos = position;
  for (let d = 0; d < levels.length - 1; d++) {
    const level = levels[d];
    const sibling = pos ^ 1;
    // An odd trailing node has no sibling; it was promoted unchanged, so it contributes nothing.
    if (sibling < level.length) proof.push(level[sibling]);
    pos = Math.floor(pos / 2);
  }
  return proof;
}

// ---------------------------------------------------------------------------------------------

type Entry = {
  userId: number;
  primary: Hex;
  addresses: Hex[];
  weight: number;
  fees: number;
  net: number;
  sweepGross: number;
  swapVolume: number;
  streakSaves: number;
  amount: bigint;
  index: number;
  /** Additive top-up from --manual. Paid ON TOP of any pro-rata share, taken off the budget. */
  bonusUsd: number;
  /** True when this account was hand-picked as an active community member. */
  community: boolean;
  /** Set when --manual grants a fixed sum. Honoured exactly, taken off the top of the budget. */
  fixedUsd: number | null;
  /** How this row got here, carried into allocation.csv so every hand edit is auditable. */
  origin: "snapshot" | "manual";
  note: string;
};

function toBaseUnits(usd: number): bigint {
  // Floor at 6 dp. Working in integer micro-USD avoids float drift on the way in.
  return BigInt(Math.floor(usd * 10 ** USDC_DECIMALS));
}

function formatUsd(base: bigint): string {
  const s = base.toString().padStart(USDC_DECIMALS + 1, "0");
  return `${s.slice(0, -USDC_DECIMALS)}.${s.slice(-USDC_DECIMALS)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const csvPath = String(args.csv || "");
  if (!csvPath || !fs.existsSync(csvPath)) {
    throw new Error("--csv is required and must point at the frozen eligibility export");
  }

  const budgetUsd = Number(args.budget ?? 20000);
  const basis = String(args.basis ?? "fees");
  const minUsd = Number(args.min ?? 0);
  const outDir = String(args.out || DEFAULT_OUT);
  // Same cutoff the snapshot CSV was taken at, so hand-added accounts are measured on the same
  // clock as everybody else rather than against a moving live database.
  const asOf = String(args["as-of"] || "2026-09-21T16:30:00.000Z");

  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error("--budget must be positive");
  if (basis !== "fees" && basis !== "net") throw new Error("--basis must be `fees` or `net`");

  const { header, rows } = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`CSV is missing the column ${name}`);
    return i;
  };
  const cUser = col("user_id");
  const cWallet = col("wallet");
  const cFees = col("total_fees_paid_usd");
  const cNet = col("net_after_all_rewards_usd");
  const cGross = col("sweep_gross_usd");
  const cVol = col("swap_volume_usd");
  const cStreak = col("streak_save_count");

  const entries: Entry[] = [];
  for (const r of rows) {
    const userId = Number(r[cUser]);
    const wallet = (r[cWallet] || "").trim().toLowerCase() as Hex;
    if (!Number.isInteger(userId) || !/^0x[0-9a-f]{40}$/.test(wallet)) {
      throw new Error(`Unusable row: user_id=${r[cUser]} wallet=${r[cWallet]}`);
    }
    const fees = Number(r[cFees] || 0);
    const net = Number(r[cNet] || 0);
    entries.push({
      userId,
      primary: wallet,
      addresses: [wallet],
      weight: basis === "fees" ? fees : Math.max(net, 0),
      fees,
      net,
      sweepGross: Number(r[cGross] || 0),
      swapVolume: Number(r[cVol] || 0),
      streakSaves: Number(r[cStreak] || 0),
      amount: 0n,
      index: -1,
      bonusUsd: 0,
      community: false,
      fixedUsd: null,
      origin: "snapshot",
      note: "",
    });
  }

  const seenUser = new Set<number>();
  for (const e of entries) {
    if (seenUser.has(e.userId)) throw new Error(`Duplicate user_id in the CSV: ${e.userId}`);
    seenUser.add(e.userId);
  }

  console.log(`Loaded ${entries.length} accounts from ${path.basename(csvPath)}`);

  // ---- exclusions --------------------------------------------------------------------------

  const excludePath = String(args.exclude || "");
  if (excludePath) {
    if (!fs.existsSync(excludePath)) throw new Error(`--exclude file not found: ${excludePath}`);
    const ex = parseCsv(fs.readFileSync(excludePath, "utf8"));
    const eAddr = ex.header.indexOf("address");
    const eUser = ex.header.indexOf("user_id");
    if (eAddr < 0 && eUser < 0) {
      throw new Error("--exclude needs an `address` or `user_id` column");
    }

    const dropAddr = new Set<string>();
    const dropUser = new Set<number>();
    for (const r of ex.rows) {
      const a = eAddr >= 0 ? (r[eAddr] || "").trim().toLowerCase() : "";
      const u = eUser >= 0 ? Number(r[eUser]) : NaN;
      if (/^0x[0-9a-f]{40}$/.test(a)) dropAddr.add(a);
      if (Number.isInteger(u)) dropUser.add(u);
    }

    const before = entries.length;
    const survivors = entries.filter(
      (e) => !dropUser.has(e.userId) && !e.addresses.some((a) => dropAddr.has(a))
    );
    entries.length = 0;
    entries.push(...survivors);
    const removed = before - entries.length;
    console.log(`Exclusions removed ${removed} accounts (${dropAddr.size + dropUser.size} listed)`);
    if (removed === 0 && dropAddr.size + dropUser.size > 0) {
      console.warn("  WARNING: nothing matched. Check the identifiers in the exclude file.");
    }
  }

  // ---- hand-added recipients ---------------------------------------------------------------

  const manualPath = String(args.manual || "");
  let manualFixedUsd = 0;
  if (manualPath) {
    if (!fs.existsSync(manualPath)) throw new Error(`--manual file not found: ${manualPath}`);
    const man = parseCsv(fs.readFileSync(manualPath, "utf8"));
    const mAddr = man.header.indexOf("address");
    const mUser = man.header.indexOf("user_id");
    const mAmount = man.header.indexOf("amount_usd");
    const mWeight = man.header.indexOf("weight_usd");
    const mBonus = man.header.indexOf("bonus_usd");
    const mNote = man.header.indexOf("note");
    if (mAddr < 0 && mUser < 0) {
      throw new Error("--manual needs an `address` or `user_id` column");
    }
    if (mAmount < 0 && mWeight < 0 && mBonus < 0) {
      throw new Error("--manual needs an `amount_usd`, `weight_usd` or `bonus_usd` column");
    }

    const byAddress = new Map<string, Entry>();
    const byUser = new Map<number, Entry>();
    for (const e of entries) {
      byUser.set(e.userId, e);
      for (const a of e.addresses) byAddress.set(a, e);
    }

    // Synthetic ids for address-only rows, kept negative so they can never collide with a real
    // account id and so the deterministic tiebreaks below still have something to sort on.
    let syntheticId = -1;
    let added = 0;
    let updated = 0;

    for (const r of man.rows) {
      const rawAddr = mAddr >= 0 ? (r[mAddr] || "").trim().toLowerCase() : "";
      const rawUser = mUser >= 0 ? (r[mUser] || "").trim() : "";
      const note = mNote >= 0 ? (r[mNote] || "").trim() : "";
      const amountUsd = mAmount >= 0 && r[mAmount]?.trim() ? Number(r[mAmount]) : null;
      const weightUsd = mWeight >= 0 && r[mWeight]?.trim() ? Number(r[mWeight]) : null;
      const bonusUsd = mBonus >= 0 && r[mBonus]?.trim() ? Number(r[mBonus]) : null;

      // Blank separator rows are allowed so the file can be grouped by hand.
      if (!rawAddr && !rawUser) continue;

      if (amountUsd === null && weightUsd === null && bonusUsd === null) {
        throw new Error(
          `Manual row for ${rawAddr || rawUser} sets none of amount_usd, weight_usd, bonus_usd`
        );
      }
      if (bonusUsd !== null && (!Number.isFinite(bonusUsd) || bonusUsd <= 0)) {
        throw new Error(`Manual row for ${rawAddr || rawUser} has a bad bonus_usd`);
      }
      if (bonusUsd !== null && amountUsd !== null) {
        throw new Error(
          `Manual row for ${rawAddr || rawUser} sets both amount_usd and bonus_usd; pick one`
        );
      }
      if (amountUsd !== null && (!Number.isFinite(amountUsd) || amountUsd <= 0)) {
        throw new Error(`Manual row for ${rawAddr || rawUser} has a bad amount_usd`);
      }
      if (weightUsd !== null && (!Number.isFinite(weightUsd) || weightUsd <= 0)) {
        throw new Error(`Manual row for ${rawAddr || rawUser} has a bad weight_usd`);
      }
      if (rawAddr && !/^0x[0-9a-f]{40}$/.test(rawAddr)) {
        throw new Error(`Manual row has a malformed address: ${rawAddr}`);
      }

      const userId = rawUser ? Number(rawUser) : NaN;
      if (rawUser && !Number.isInteger(userId)) {
        throw new Error(`Manual row has a non-numeric user_id: ${rawUser}`);
      }

      const existing = rawAddr ? byAddress.get(rawAddr) : byUser.get(userId);

      if (existing) {
        // Already on the list. Adjust in place rather than creating a second leaf for the
        // same person, which would pay them twice.
        if (amountUsd !== null) existing.fixedUsd = amountUsd;
        if (weightUsd !== null) existing.weight = weightUsd;
        if (bonusUsd !== null) {
          // Additive on purpose: an account already on the list keeps its pro-rata share and
          // receives this on top.
          existing.bonusUsd += bonusUsd;
          existing.community = true;
        }
        existing.note = note || existing.note;
        updated++;
        continue;
      }

      if (!rawAddr) {
        // user_id with no address. The DB pass below fills in the wallets; until then there is
        // nothing to hash, so refuse rather than silently dropping the person.
        if (args["no-db"]) {
          throw new Error(
            `Manual row for user_id ${userId} needs --db access to resolve an address, or give the address directly`
          );
        }
      }

      const address = (rawAddr || "0x") as Hex;
      const entry: Entry = {
        userId: rawUser ? userId : syntheticId--,
        primary: address,
        addresses: rawAddr ? [address] : [],
        weight: weightUsd ?? 0,
        fees: 0,
        net: 0,
        sweepGross: 0,
        swapVolume: 0,
        streakSaves: 0,
        amount: 0n,
        index: -1,
        bonusUsd: bonusUsd ?? 0,
        community: bonusUsd !== null,
        fixedUsd: amountUsd,
        origin: "manual",
        note,
      };
      entries.push(entry);
      if (rawAddr) byAddress.set(rawAddr, entry);
      if (rawUser) byUser.set(userId, entry);
      added++;
    }

    manualFixedUsd = entries.reduce((s, e) => s + (e.fixedUsd ?? 0), 0);
    const manualBonusUsd = entries.reduce((s, e) => s + e.bonusUsd, 0);
    console.log(
      `Manual file: ${added} added, ${updated} updated in place, ` +
        `${manualFixedUsd.toFixed(2)} USD fixed, ${manualBonusUsd.toFixed(2)} USD bonuses`
    );
  }

  // Every wallet linked to an eligible account gets its own leaf at the SAME index, so either
  // wallet can claim and the account is still paid exactly once (the bitmap is keyed on index).
  if (!args["no-db"]) {
    const conn = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    if (!conn) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL must be set, or pass --no-db");
    const client = new Client({ connectionString: conn });
    await client.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const res = await client.query<{ user_id: number; wallet_address: string }>(
        `SELECT user_id, wallet_address FROM user_wallets WHERE user_id = ANY($1::int[])`,
        [entries.map((e) => e.userId)]
      );
      await client.query("COMMIT");

      const byUser = new Map<number, Set<string>>();
      for (const row of res.rows) {
        const addr = row.wallet_address.trim().toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
        if (!byUser.has(row.user_id)) byUser.set(row.user_id, new Set());
        byUser.get(row.user_id)!.add(addr);
      }

      let extra = 0;
      for (const e of entries) {
        const linked = byUser.get(e.userId);
        if (!linked) continue;
        for (const addr of linked) {
          if (!e.addresses.includes(addr as Hex)) {
            e.addresses.push(addr as Hex);
            extra++;
          }
        }
      }
      console.log(`Linked-wallet expansion added ${extra} extra addresses`);

      // A hand-added account is not in the snapshot CSV, so its activity totals are still zero.
      // Leaving them at zero would show somebody "your total swap volume $0.00" next to real
      // history, so they are read from the database with the same logic and the same cutoff the
      // snapshot used. Display only: these never touch the leaf hash or the allocation.
      const needStats = entries.filter(
        (e) => e.origin === "manual" && e.sweepGross === 0 && e.swapVolume === 0 && e.streakSaves === 0
      );
      const realIds = needStats.map((e) => e.userId).filter((id) => id > 0);

      if (realIds.length > 0) {
        await client.query("BEGIN READ ONLY");
        const stats = await client.query<{
          uid: number;
          swap_volume: string | null;
          sweep_gross: string | null;
          streak_saves: string | null;
        }>(
          `WITH RECURSIVE m(uid, root, depth) AS (
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
           want(uid) AS (SELECT unnest($1::int[])),
           -- Aggregated once each, not once per account. The correlated form re-scanned
           -- swap_transactions for every id and did not finish in five minutes.
           sw AS (
             SELECT c.root AS uid, sum(t.amount_usd) AS v
             FROM swap_transactions t
             JOIN canon c ON c.uid = t.user_id
             WHERE c.root IN (SELECT uid FROM want) AND t.occurred_at < $2::timestamptz
             GROUP BY 1
           ),
           sp AS (
             SELECT c.root AS uid, sum(COALESCE(s.value_usd, 0)) AS v
             FROM sweeps s
             JOIN addr_owner a ON a.addr = lower(s.user_address)
             JOIN canon c ON c.uid = a.uid
             WHERE c.root IN (SELECT uid FROM want) AND s.created_at < $2::timestamptz
             GROUP BY 1
           ),
           st AS (
             SELECT c.root AS uid, count(*) AS v
             FROM streak_recovery_events sr
             JOIN canon c ON c.uid = sr.user_id
             WHERE c.root IN (SELECT uid FROM want) AND sr.created_at < $2::timestamptz
             GROUP BY 1
           )
           SELECT w.uid,
                  sw.v AS swap_volume,
                  sp.v AS sweep_gross,
                  st.v AS streak_saves
           FROM want w
           LEFT JOIN sw ON sw.uid = w.uid
           LEFT JOIN sp ON sp.uid = w.uid
           LEFT JOIN st ON st.uid = w.uid`,
          [realIds, asOf]
        );
        await client.query("COMMIT");

        const byId = new Map(stats.rows.map((r) => [r.uid, r]));
        let filled = 0;
        for (const e of needStats) {
          const row = byId.get(e.userId);
          if (!row) continue;
          e.swapVolume = Number(row.swap_volume ?? 0);
          e.sweepGross = Number(row.sweep_gross ?? 0);
          e.streakSaves = Number(row.streak_saves ?? 0);
          if (e.swapVolume > 0 || e.sweepGross > 0 || e.streakSaves > 0) filled++;
        }
        console.log(`Activity lookup filled real totals for ${filled}/${needStats.length} hand-added accounts`);
      }
    } finally {
      await client.end();
    }
  }

  // A manual row given by user_id only had no address until the lookup above ran. If it still
  // has none, that account has no wallet on file and cannot be paid, so stop rather than
  // quietly producing a tree that is missing someone the user asked for by hand.
  for (const e of entries) {
    if (e.addresses.length === 0) {
      throw new Error(
        `No wallet on file for user_id ${e.userId}. Give an address directly in the manual file.`
      );
    }
    if (!/^0x[0-9a-f]{40}$/.test(e.primary)) {
      e.primary = e.addresses[0];
    }
  }

  // No address may appear under two accounts, or one claim would cancel another.
  const owner = new Map<string, number>();
  for (const e of entries) {
    for (const a of e.addresses) {
      const prev = owner.get(a);
      if (prev !== undefined && prev !== e.userId) {
        throw new Error(`Address ${a} is claimed by both user ${prev} and user ${e.userId}`);
      }
      owner.set(a, e.userId);
    }
  }

  // ---- allocation -------------------------------------------------------------------------

  const budgetBase = toBaseUnits(budgetUsd);
  const minBase = toBaseUnits(minUsd);

  // Fixed grants are honoured to the cent. Whatever is left is what the pro-rata pool shares.
  const fixedEntries = entries.filter((e) => e.fixedUsd !== null);
  const fixedBase = fixedEntries.reduce((s, e) => s + toBaseUnits(e.fixedUsd as number), 0n);
  if (fixedBase > budgetBase) {
    throw new Error(
      `Fixed grants total ${formatUsd(fixedBase)}, which is more than the ${formatUsd(budgetBase)} budget`
    );
  }
  // Community bonuses also come off the top. What is left is what the pro-rata pool shares.
  const bonusBase = entries.reduce((sum, e) => sum + toBaseUnits(e.bonusUsd), 0n);
  if (fixedBase + bonusBase > budgetBase) {
    throw new Error(
      `Fixed grants plus bonuses total ${formatUsd(fixedBase + bonusBase)}, more than the ${formatUsd(budgetBase)} budget`
    );
  }
  const prorataBase = budgetBase - fixedBase - bonusBase;
  const prorataUsd = Number(prorataBase) / 10 ** USDC_DECIMALS;

  if (bonusBase > 0n) {
    const recipients = entries.filter((e) => e.bonusUsd > 0).length;
    console.log(
      `Bonuses: ${formatUsd(bonusBase)} to ${recipients} accounts, ` +
        `${formatUsd(prorataBase)} left for the pro-rata pool`
    );
  }

  // A zero-weight account (added by hand, no snapshot activity) takes no pro-rata share, so it
  // stays out of the pool entirely and is paid its bonus alone.
  let pool = entries.filter((e) => e.fixedUsd === null && e.weight > 0);
  const totalWeight = pool.reduce((s, e) => s + e.weight, 0);
  if (pool.length > 0 && totalWeight <= 0) {
    throw new Error("Total weight of the pro-rata pool is zero; nothing to distribute");
  }
  if (pool.length === 0 && prorataBase > 0n) {
    throw new Error(
      `Fixed grants leave ${formatUsd(prorataBase)} undistributed and there is nobody to share it`
    );
  }
  if (fixedBase > 0n) {
    console.log(
      `Fixed grants: ${formatUsd(fixedBase)} to ${fixedEntries.length} recipients, ` +
        `${formatUsd(prorataBase)} left for the pro-rata pool`
    );
  }

  if (minBase > 0n && pool.length > 0) {
    const provisional = (e: Entry) => toBaseUnits((e.weight / totalWeight) * prorataUsd);
    const before = pool.length;
    pool = pool.filter((e) => provisional(e) >= minBase);
    console.log(`Minimum of ${minUsd} USDC dropped ${before - pool.length} accounts`);
    if (pool.length === 0) throw new Error("The minimum removed every account in the pool");
  }

  const poolWeight = pool.reduce((s, e) => s + e.weight, 0);

  // Largest-remainder apportionment, so the allocations sum to the budget exactly rather than
  // landing a few base units short after flooring.
  const exact = pool.map((e) => (e.weight / poolWeight) * prorataUsd * 10 ** USDC_DECIMALS);
  const floored = exact.map((v) => BigInt(Math.floor(v)));
  const remainder = prorataBase - floored.reduce((s, v) => s + v, 0n);

  const order = pool
    .map((_, i) => i)
    .sort((a, b) => {
      const fa = exact[a] - Math.floor(exact[a]);
      const fb = exact[b] - Math.floor(exact[b]);
      if (fb !== fa) return fb - fa;
      return pool[a].userId - pool[b].userId; // deterministic tiebreak
    });

  for (let i = 0; i < Number(remainder); i++) {
    floored[order[i % order.length]] += 1n;
  }

  pool.forEach((e, i) => {
    e.amount = floored[i];
  });
  for (const e of fixedEntries) {
    e.amount = toBaseUnits(e.fixedUsd as number);
  }

  // Bonuses land on top of whatever the account already has, which may be nothing.
  const bonusOnly = entries.filter((e) => e.fixedUsd === null && e.weight <= 0 && e.bonusUsd > 0);
  for (const e of [...pool, ...fixedEntries, ...bonusOnly]) {
    if (e.bonusUsd > 0) e.amount += toBaseUnits(e.bonusUsd);
  }

  const kept = [...fixedEntries, ...pool, ...bonusOnly];
  const assigned = kept.reduce((s, e) => s + e.amount, 0n);
  if (assigned !== budgetBase) {
    throw new Error(`Allocation sums to ${formatUsd(assigned)}, expected ${formatUsd(budgetBase)}`);
  }
  if (kept.some((e) => e.amount <= 0n)) {
    throw new Error("At least one recipient was allocated nothing; raise --budget or set --min");
  }

  // Index order is fixed and deterministic: descending allocation, then ascending user id.
  kept.sort((a, b) => (b.amount === a.amount ? a.userId - b.userId : b.amount > a.amount ? 1 : -1));
  kept.forEach((e, i) => {
    e.index = i;
  });

  // ---- tree -------------------------------------------------------------------------------

  type Leaf = {
    hash: Hex;
    index: number;
    account: Hex;
    amount: bigint;
    userId: number;
    entry: Entry;
  };
  const leaves: Leaf[] = [];
  for (const e of kept) {
    for (const account of e.addresses) {
      leaves.push({
        hash: leafHash(e.index, account, e.amount),
        index: e.index,
        account,
        amount: e.amount,
        userId: e.userId,
        entry: e,
      });
    }
  }

  const hashes = leaves.map((l) => l.hash);
  if (new Set(hashes).size !== hashes.length) throw new Error("Duplicate leaf hash");

  leaves.sort((a, b) => (a.hash.toLowerCase() < b.hash.toLowerCase() ? -1 : 1));
  const levels = buildLevels(leaves.map((l) => l.hash));
  const root = levels[levels.length - 1][0];

  // ---- verify every proof before writing anything ------------------------------------------

  leaves.forEach((l, pos) => {
    const proof = proofFor(levels, pos);
    let node = l.hash;
    for (const sib of proof) node = hashPair(node, sib);
    if (node !== root) throw new Error(`Proof does not reconstruct the root for ${l.account}`);
  });
  console.log(`Verified ${leaves.length} proofs against root ${root}`);

  // ---- write -------------------------------------------------------------------------------

  fs.mkdirSync(outDir, { recursive: true });
  const proofsDir = path.join(outDir, "proofs");
  fs.mkdirSync(proofsDir, { recursive: true });

  type Stats = { sv: string; wv: string; ss: number; cm: 0 | 1 };
  const statsOf = (e: Entry): Stats => ({
    sv: e.sweepGross.toFixed(2),
    wv: e.swapVolume.toFixed(2),
    ss: e.streakSaves,
    cm: e.community ? 1 : 0,
  });

  // The index carries ONLY what eligibility needs. Activity totals live in the per-address
  // proof file instead, so one public download cannot yield every user trading history.
  const eligibility: Record<string, { i: number; a: string }> = {};
  leaves.forEach((l, pos) => {
    const stats = statsOf(l.entry);
    eligibility[l.account] = { i: l.index, a: l.amount.toString() };
    fs.writeFileSync(
      path.join(proofsDir, `${l.account}.json`),
      JSON.stringify({
        i: l.index,
        a: l.amount.toString(),
        ...stats,
        p: proofFor(levels, pos),
      })
    );
  });

  fs.writeFileSync(
    path.join(outDir, "eligibility.json"),
    JSON.stringify(
      {
        root,
        totalAllocation: budgetBase.toString(),
        totalAllocationUsd: formatUsd(budgetBase),
        accounts: kept.length,
        addresses: leaves.length,
        basis,
        builtAt: new Date().toISOString(),
        source: path.basename(csvPath),
        entries: eligibility,
      },
      null,
      0
    )
  );

  const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csvOut = [
    "index,user_id,address,amount_usdc,amount_base_units,prorata_usdc,bonus_usdc,community_member,origin,note,weight_usd,total_fees_paid_usd,net_after_all_rewards_usd,sweep_gross_usd,swap_volume_usd,streak_save_count,meets_published_criteria",
    ...kept.flatMap((e) =>
      e.addresses.map((a) =>
        [
          e.index,
          e.userId,
          a,
          formatUsd(e.amount),
          e.amount.toString(),
          formatUsd(e.amount - toBaseUnits(e.bonusUsd)),
          e.bonusUsd.toFixed(2),
          e.community ? "yes" : "no",
          e.origin,
          csvCell(e.note),
          e.weight.toFixed(4),
          e.fees.toFixed(4),
          e.net.toFixed(4),
          e.sweepGross.toFixed(2),
          e.swapVolume.toFixed(2),
          String(e.streakSaves),
          e.sweepGross >= 10 || e.swapVolume >= 100 || e.streakSaves >= 1 || e.community
            ? "yes"
            : "no",
        ].join(",")
      )
    ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "allocation.csv"), csvOut);

  const snapshotRows = kept.filter((e) => e.origin === "snapshot");
  const meets = kept.filter(
    (e) => e.sweepGross >= 10 || e.swapVolume >= 100 || e.streakSaves >= 1 || e.community
  ).length;
  const amounts = kept.map((e) => e.amount).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const summary = {
    root,
    totalAllocationUsd: formatUsd(budgetBase),
    totalAllocationBaseUnits: budgetBase.toString(),
    accounts: kept.length,
    addressesInTree: leaves.length,
    treeDepth: levels.length - 1,
    basis,
    fromSnapshot: snapshotRows.length,
    addedByHand: kept.length - snapshotRows.length,
    fixedGrantsUsd: formatUsd(fixedBase),
    bonusesUsd: formatUsd(bonusBase),
    bonusRecipients: kept.filter((e) => e.bonusUsd > 0).length,
    bonusOnlyAccounts: kept.filter((e) => e.bonusUsd > 0 && e.weight <= 0).length,
    prorataUsd: formatUsd(prorataBase),
    prorataFactor: (Number(prorataBase) / 10 ** USDC_DECIMALS / poolWeight).toFixed(6),
    smallestUsd: formatUsd(amounts[0]),
    medianUsd: formatUsd(amounts[Math.floor(amounts.length / 2)]),
    largestUsd: formatUsd(amounts[amounts.length - 1]),
    meetsPublishedCriteria: meets,
    belowPublishedCriteria: kept.length - meets,
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

  console.log("\n" + JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${outDir}`);
  console.log("  eligibility.json   address -> {index, amount}");
  console.log("  proofs/<addr>.json per-address proof, fetched lazily by the claim page");
  console.log("  allocation.csv     the publishable list");
  console.log("  summary.json");
  console.log(`\nConstructor args:\n  merkleRoot      ${root}\n  totalAllocation ${budgetBase}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

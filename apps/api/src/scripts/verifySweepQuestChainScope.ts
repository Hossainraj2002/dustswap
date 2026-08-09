/**
 * Read-only verification of sweep-quest chain scoping.
 *
 * Sweep quests used to hardcode `.eq("chain_id", 8453)` in syncSweepProgressForQuest, so a
 * multi-network sweep quest was impossible. They now honour `rules.chainIds` exactly the way swap
 * quests always have (syncSwapProgressForQuest): an explicit list restricts the query to those
 * chains, and an omitted list counts EVERY chain.
 *
 * This script proves the three cases against the live `sweeps` table:
 *   1. a Base-only quest  ("chainIds": [8453])       counts only 8453 rows
 *   2. a multi quest      ("chainIds": [8453, 56])   counts both chains
 *   3. an omitted list    ({})                       counts every chain (the chosen default)
 *
 * getQuestChainIds is imported from questEngine, so case selection is the REAL decision function,
 * not a copy. The Supabase filter chain is mirrored here (calling the real
 * syncSweepProgressForQuest would WRITE progress rows and award points, which a probe must not do).
 *
 * Run (from apps/api):
 *   npx ts-node -r dotenv/config src/scripts/verifySweepQuestChainScope.ts
 *
 * postgresDb reads DATABASE_URL, which on Railway is the INTERNAL host and does not resolve from a
 * laptop. Off-platform, point it at the public proxy for the run:
 *   DATABASE_URL="$DATABASE_PUBLIC_URL" npx ts-node -r dotenv/config src/scripts/verifySweepQuestChainScope.ts
 *
 * NEVER wire this into CI — it reads the production database. It mutates nothing: every statement
 * is a SELECT, and it deliberately does not call syncSweepProgressForQuest (that would write
 * progress rows and award points).
 */

import { postgresDb } from "../services/postgres";
import { getQuestChainIds } from "../services/questEngine";

type Case = { label: string; rules: Record<string, unknown> };

const RESOLUTION_CASES: Case[] = [
  { label: 'omitted            {}', rules: {} },
  { label: 'Base-only          {"chainIds":[8453]}', rules: { chainIds: [8453] } },
  { label: 'multi              {"chainIds":[8453,56]}', rules: { chainIds: [8453, 56] } },
  { label: 'all-network        {"chainIds":[8453,1,56,42161]}', rules: { chainIds: [8453, 1, 56, 42161] } },
  { label: 'legacy singular    {"chainId":56}', rules: { chainId: 56 } },
  { label: 'empty list         {"chainIds":[]}', rules: { chainIds: [] } },
  { label: 'garbage only       {"chainIds":["x",-1,0]}', rules: { chainIds: ["x", -1, 0] } },
];

/** The exact filter chain syncSweepProgressForQuest builds, minus the created_at window. */
async function progressFor(address: string, rules: Record<string, unknown>) {
  const chainIds = getQuestChainIds(rules as never);

  let query = postgresDb
    .from("sweeps")
    .select("value_usd, tokens_swapped, chain_id")
    .eq("user_address", address.toLowerCase());

  if (chainIds.length > 0) {
    query = query.in("chain_id", chainIds);
  }

  const result = await query;
  if (result.error) throw new Error(`Failed to load sweeps: ${result.error.message}`);

  const rows = (result.data ?? []) as Array<{
    value_usd: number | string | null;
    tokens_swapped: number | string | null;
    chain_id: number | null;
  }>;

  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    chainIds,
    count: rows.length,
    volume: rows.reduce((sum, r) => sum + num(r.value_usd), 0),
    tokensMax: rows.reduce((max, r) => Math.max(max, num(r.tokens_swapped)), 0),
    chains: [...new Set(rows.map((r) => r.chain_id))].sort((a, b) => Number(a) - Number(b)),
  };
}

async function main() {
  console.log("=== getQuestChainIds() — the real decision function ===");
  for (const { label, rules } of RESOLUTION_CASES) {
    const ids = getQuestChainIds(rules as never);
    console.log(
      `  ${label.padEnd(46)} -> [${ids.join(",")}]  ${
        ids.length > 0 ? "IN filter applied" : "NO filter => ALL chains"
      }`,
    );
  }

  // A wallet that genuinely swept on more than one chain, so the cases actually differ.
  const { data, error } = await postgresDb
    .from("sweeps")
    .select("user_address, chain_id")
    .neq("chain_id", 8453);
  if (error) throw new Error(error.message);

  const candidates = [...new Set(((data ?? []) as Array<{ user_address: string }>).map((r) => r.user_address))];
  let address: string | null = null;
  for (const candidate of candidates) {
    const baseRows = await postgresDb
      .from("sweeps")
      .select("id", { count: "exact", head: true })
      .eq("user_address", candidate)
      .eq("chain_id", 8453);
    if ((baseRows.count || 0) > 0) {
      address = candidate;
      break;
    }
  }
  if (!address) {
    console.log("\nNo wallet with sweeps on both Base and another chain — data cases skipped.");
    return;
  }

  console.log(`\n=== live wallet with sweeps on >1 chain: ${address.slice(0, 10)}…${address.slice(-6)} ===`);

  // Derive the multi-network case from the chains this wallet ACTUALLY swept on, so the assertion
  // stays meaningful whichever wallet the scan lands on (its second chain may be 1, 56 or 42161).
  const omitted = await progressFor(address, {});
  const otherChain = omitted.chains.map(Number).find((c) => c !== 8453);
  if (otherChain === undefined) throw new Error("selected wallet has no non-Base chain");

  const baseOnly = await progressFor(address, { chainIds: [8453] });
  const multi = await progressFor(address, { chainIds: [8453, otherChain] });
  const arbOnly = await progressFor(address, { chainIds: [42161] });

  for (const [label, r] of [
    ["Base-only  [8453]", baseOnly],
    [`Multi      [8453,${otherChain}]`, multi],
    ["Omitted    {}", omitted],
    ["Arb-only   [42161]", arbOnly],
  ] as Array<[string, Awaited<ReturnType<typeof progressFor>>]>) {
    console.log(
      `  ${label.padEnd(22)} resolved=[${r.chainIds.join(",")}]`.padEnd(56) +
        `counted=[${r.chains.join(",")}] count=${r.count} volume=${r.volume.toFixed(2)} tokensAtOnce=${r.tokensMax}`,
    );
  }

  const assertions: Array<[string, boolean]> = [
    ["Base-only quest counts ONLY 8453 rows", baseOnly.chains.every((c) => Number(c) === 8453)],
    [
      `[8453,${otherChain}] quest counts BOTH chains`,
      multi.chains.length === 2 && multi.chains.map(Number).includes(otherChain),
    ],
    ["multi count > Base-only count (the filter really moves)", multi.count > baseOnly.count],
    ["omitted counts every chain (chosen default)", omitted.count >= multi.count],
    ["Arbitrum-only quest counts only 42161 rows", arbOnly.chains.every((c) => Number(c) === 42161)],
  ];

  console.log("\n=== assertions ===");
  for (const [label, ok] of assertions) console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
  const allPassed = assertions.every(([, ok]) => ok);
  console.log(`\n  OVERALL: ${allPassed ? "ALL PASS" : "FAILURES PRESENT"}`);
  if (!allPassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

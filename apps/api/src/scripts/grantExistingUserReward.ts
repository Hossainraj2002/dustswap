import "dotenv/config";

import { getAddress } from "viem";
import { pointsEngine } from "../services/pointsEngine";
import { postgresDb } from "../services/postgres";

const CAMPAIGN_ACTION = "existing_user_reward_apr_2026";
const CAMPAIGN_NAME = "Existing user reward";
const REWARD_POINTS = 20_000;
const MIN_EXISTING_POINTS = 1;
const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_CONCURRENCY = 20;
const EXCLUDED_ADDRESSES = new Set(
  [
    "0xd4a1d777e2882487d47c96bc23a47ceab4f4f18a",
    "0xB4Cc7bFDd62b6FaA6c24ff01C597b085Dfadf470",
  ].map((value) => getAddress(value).toLowerCase())
);

type EligibleUserRow = {
  id: number | string;
  address: string;
  total_points: number | string | null;
  created_at: string | null;
};

type AwardedRow = {
  user_id: number | string;
};

type CliOptions = {
  apply: boolean;
  cutoffIso: string;
  cutoffWasProvided: boolean;
  pageSize: number;
  concurrency: number;
};

function printHelp() {
  console.log(`
DustSwap existing-user reward script

Dry run:
  pnpm run grant-existing-user-reward

Apply:
  pnpm run grant-existing-user-reward -- --apply --cutoff=2026-04-09T12:00:00.000Z

Options:
  --apply                 Writes point events and updates user totals
  --cutoff=<ISO>          Only users created at or before this timestamp are eligible
  --page-size=<number>    Pagination size for database reads (default: ${DEFAULT_PAGE_SIZE})
  --concurrency=<number>  Parallel award workers during apply (default: ${DEFAULT_CONCURRENCY})
  --help                  Show this message
`);
}

function parsePositiveInteger(value: string, label: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  let apply = false;
  let cutoffIso = new Date().toISOString();
  let cutoffWasProvided = false;
  let pageSize = DEFAULT_PAGE_SIZE;
  let concurrency = DEFAULT_CONCURRENCY;

  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
      continue;
    }

    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg.startsWith("--cutoff=")) {
      cutoffIso = arg.slice("--cutoff=".length);
      cutoffWasProvided = true;
      continue;
    }

    if (arg.startsWith("--page-size=")) {
      pageSize = parsePositiveInteger(arg.slice("--page-size=".length), "page-size");
      continue;
    }

    if (arg.startsWith("--concurrency=")) {
      concurrency = parsePositiveInteger(
        arg.slice("--concurrency=".length),
        "concurrency"
      );
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  const cutoffDate = new Date(cutoffIso);
  if (Number.isNaN(cutoffDate.getTime())) {
    throw new Error("cutoff must be a valid ISO timestamp");
  }

  return {
    apply,
    cutoffIso: cutoffDate.toISOString(),
    cutoffWasProvided,
    pageSize,
    concurrency,
  };
}

function formatNumber(value: number) {
  return value.toLocaleString();
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function loadEligibleUsers(cutoffIso: string, pageSize: number) {
  const rows: EligibleUserRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await postgresDb
      .from("users")
      .select("id, address, total_points, created_at")
      .gte("total_points", MIN_EXISTING_POINTS)
      .lte("created_at", cutoffIso)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Load eligible users: ${error.message}`);
    }

    const batch = ((data as EligibleUserRow[] | null) ?? []).filter((row) => {
      try {
        return !EXCLUDED_ADDRESSES.has(getAddress(row.address).toLowerCase());
      } catch {
        return false;
      }
    });

    rows.push(...batch);

    if (!data || data.length < pageSize) {
      break;
    }
  }

  return rows;
}

async function loadAlreadyAwardedUserIds(pageSize: number) {
  const userIds = new Set<number>();

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await postgresDb
      .from("point_events")
      .select("user_id")
      .eq("action", CAMPAIGN_ACTION)
      .order("user_id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Load already-awarded users: ${error.message}`);
    }

    const batch = (data as AwardedRow[] | null) ?? [];
    for (const row of batch) {
      userIds.add(Number(row.user_id));
    }

    if (batch.length < pageSize) {
      break;
    }
  }

  return userIds;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.apply && !options.cutoffWasProvided) {
    throw new Error(
      "Apply mode requires an explicit --cutoff ISO timestamp so the campaign stays limited to existing users."
    );
  }

  console.log(`[Existing User Reward] Campaign action: ${CAMPAIGN_ACTION}`);
  console.log(`[Existing User Reward] Reward: ${formatNumber(REWARD_POINTS)} PP`);
  console.log(`[Existing User Reward] Minimum existing points: ${MIN_EXISTING_POINTS}`);
  console.log(`[Existing User Reward] Cutoff: ${options.cutoffIso}`);
  console.log(
    `[Existing User Reward] Excluded founders: ${Array.from(EXCLUDED_ADDRESSES).join(", ")}`
  );

  const [eligibleUsers, alreadyAwardedUserIds] = await Promise.all([
    loadEligibleUsers(options.cutoffIso, options.pageSize),
    loadAlreadyAwardedUserIds(options.pageSize),
  ]);

  const pendingUsers = eligibleUsers.filter(
    (user) => !alreadyAwardedUserIds.has(Number(user.id))
  );
  const alreadyAwardedEligibleCount = eligibleUsers.length - pendingUsers.length;

  console.log(
    `[Existing User Reward] Eligible existing users: ${formatNumber(eligibleUsers.length)}`
  );
  console.log(
    `[Existing User Reward] Already awarded in this cohort: ${formatNumber(
      alreadyAwardedEligibleCount
    )}`
  );
  console.log(
    `[Existing User Reward] Pending award count: ${formatNumber(pendingUsers.length)}`
  );

  if (pendingUsers.length > 0) {
    const preview = pendingUsers
      .slice(0, 5)
      .map((user) => `${shortAddress(user.address)} (${formatNumber(Number(user.total_points || 0))} PP)`)
      .join(", ");
    console.log(`[Existing User Reward] Pending sample: ${preview}`);
  }

  if (!options.apply) {
    console.log("");
    console.log("Dry run only. No points were written.");
    console.log(
      `Apply with: pnpm run grant-existing-user-reward -- --apply --cutoff=${options.cutoffIso}`
    );
    return;
  }

  if (pendingUsers.length === 0) {
    console.log("[Existing User Reward] Nothing to award.");
    return;
  }

  let awardedCount = 0;
  let skippedCount = 0;
  const failures: Array<{ address: string; error: string }> = [];

  for (let index = 0; index < pendingUsers.length; index += options.concurrency) {
    const batch = pendingUsers.slice(index, index + options.concurrency);
    await Promise.all(
      batch.map(async (user) => {
        try {
          const result = await pointsEngine.awardOneTimeCampaignPoints({
            address: user.address,
            points: REWARD_POINTS,
            action: CAMPAIGN_ACTION,
            metadata: {
              campaignId: CAMPAIGN_ACTION,
              campaignName: CAMPAIGN_NAME,
              rewardType: "existing_user_airdrop",
              rewardPoints: REWARD_POINTS,
              minimumExistingPoints: MIN_EXISTING_POINTS,
              cutoffIso: options.cutoffIso,
              previousTotalPoints: Number(user.total_points || 0),
              excludedFounderAddresses: Array.from(EXCLUDED_ADDRESSES),
            },
          });

          if (result.alreadyAwarded) {
            skippedCount += 1;
            return;
          }

          awardedCount += 1;
        } catch (error) {
          failures.push({
            address: user.address,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );

    console.log(
      `[Existing User Reward] Progress: ${formatNumber(
        Math.min(index + batch.length, pendingUsers.length)
      )}/${formatNumber(pendingUsers.length)} processed`
    );
  }

  console.log("");
  console.log(`[Existing User Reward] Awarded: ${formatNumber(awardedCount)}`);
  console.log(`[Existing User Reward] Skipped as already awarded: ${formatNumber(skippedCount)}`);
  console.log(`[Existing User Reward] Failures: ${formatNumber(failures.length)}`);

  if (failures.length > 0) {
    for (const failure of failures.slice(0, 10)) {
      console.log(
        `[Existing User Reward] Failure ${failure.address}: ${failure.error}`
      );
    }

    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(
    `[Existing User Reward] ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});

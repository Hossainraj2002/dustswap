import dotenv from "dotenv";
dotenv.config();

import { questEngine } from "../services/questEngine";
import { supabase } from "../services/supabase";

type QuestRow = {
  id: string;
  slug: string;
  title: string;
};

type PendingProgressRow = {
  id: number;
  quest_id: string;
  user_id: number;
  cycle_key: string;
};

const PAGE_SIZE = 1000;

function getArgs() {
  const rawArgs = process.argv.slice(2);
  const args = new Set(rawArgs);
  const limitArg = rawArgs.find((arg) => arg.startsWith("--limit="));
  const slugsArg = rawArgs.find((arg) => arg.startsWith("--slugs="));

  return {
    dryRun: args.has("--dry-run"),
    limit:
      limitArg && Number.isInteger(Number(limitArg.split("=")[1]))
        ? Math.max(1, Number(limitArg.split("=")[1]))
        : null,
    slugs:
      slugsArg
        ?.split("=")[1]
        ?.split(",")
        .map((slug) => slug.trim())
        .filter(Boolean) || null,
  };
}

function getConfiguredSlugs(cliSlugs: string[] | null) {
  if (cliSlugs?.length) {
    return cliSlugs;
  }

  return (process.env.X_REPOST_REVIEW_SLUGS || "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
}

async function fetchRepostQuests(slugs: string[]) {
  let query = supabase
    .from("quests")
    .select("id, slug, title")
    .eq("platform", "x")
    .eq("action_type", "repost");

  if (slugs.length > 0) {
    query = query.in("slug", slugs);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Load repost quests: ${error.message}`);
  }

  return (data || []) as QuestRow[];
}

async function fetchPendingRows(questIds: string[], limit: number | null) {
  const rows: PendingProgressRow[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const to = limit ? Math.min(from + PAGE_SIZE - 1, limit - 1) : from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("quest_progress")
      .select("id, quest_id, user_id, cycle_key")
      .in("quest_id", questIds)
      .eq("status", "pending_review")
      .is("completed_at", null)
      .is("rewarded_at", null)
      .range(from, to);

    if (error) {
      throw new Error(`Load pending repost progress: ${error.message}`);
    }

    rows.push(...((data || []) as PendingProgressRow[]));
    if (!data || data.length < PAGE_SIZE || (limit && rows.length >= limit)) {
      return limit ? rows.slice(0, limit) : rows;
    }
  }
}

async function logReviewCompletion(row: PendingProgressRow, quest: QuestRow, awardedPoints: number) {
  const { error } = await supabase.from("quest_verification_logs").insert({
    user_id: row.user_id,
    quest_id: row.quest_id,
    cycle_key: row.cycle_key,
    status: "completed",
    request_payload: {
      actionType: "repost",
      verificationType: "daily_pending_review",
      reviewMode: "opened_task",
    },
    response_payload: {
      questSlug: quest.slug,
      awardedPoints,
      verifiedByApi: false,
    },
  });

  if (error) {
    console.warn(`Failed to write review log for progress ${row.id}: ${error.message}`);
  }
}

async function main() {
  const args = getArgs();
  const slugs = getConfiguredSlugs(args.slugs);
  const quests = await fetchRepostQuests(slugs);
  const questById = new Map(quests.map((quest) => [quest.id, quest]));

  if (quests.length === 0) {
    console.log("No X repost quests found.");
    return;
  }

  const pendingRows = await fetchPendingRows(
    quests.map((quest) => quest.id),
    args.limit
  );

  console.log(
    `${args.dryRun ? "Dry run" : "Real run"}: ${pendingRows.length} pending repost quest row(s)`
  );
  console.log(`Quests: ${quests.map((quest) => quest.slug).join(", ")}`);

  const totals = {
    completed: 0,
    awardedPoints: 0,
    failed: 0,
  };

  for (const row of pendingRows) {
    const quest = questById.get(row.quest_id);
    if (!quest) {
      totals.failed += 1;
      console.warn(`Skipping progress ${row.id}: quest not found in active repost set`);
      continue;
    }

    if (args.dryRun) {
      totals.completed += 1;
      continue;
    }

    try {
      const result = await questEngine.completePendingReviewProgress(row.id, {
        review_provider: "daily_pending_review",
        review_mode: "opened_task",
        reviewed_at: new Date().toISOString(),
      });

      totals.completed += 1;
      totals.awardedPoints += result.awardedPoints;
      await logReviewCompletion(row, quest, result.awardedPoints);
    } catch (error) {
      totals.failed += 1;
      console.error(`Failed progress ${row.id}: ${(error as Error).message}`);
    }
  }

  console.log(
    `Done. completed=${totals.completed} awarded_points=${totals.awardedPoints} failed=${totals.failed}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

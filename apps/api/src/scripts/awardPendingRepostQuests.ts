import dotenv from "dotenv";
dotenv.config();

import {
  awardPendingRepostQuests,
  type AwardPendingRepostQuestsOptions,
} from "../services/repostQuestRewards";

function getValueArg(name: string) {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function getArgs(): AwardPendingRepostQuestsOptions {
  const rawArgs = process.argv.slice(2);
  const args = new Set(rawArgs);
  const limitArg = getValueArg("limit");
  const slugsArg = getValueArg("slugs");
  const cutoffArg = getValueArg("before") || getValueArg("cutoff");

  return {
    dryRun: args.has("--dry-run"),
    limit:
      limitArg && Number.isInteger(Number(limitArg))
        ? Math.max(1, Number(limitArg))
        : null,
    slugs:
      slugsArg
        ?.split(",")
        .map((slug) => slug.trim())
        .filter(Boolean) || null,
    cutoff: cutoffArg || null,
    source: args.has("--dry-run") ? "script_dry_run" : "script",
  };
}

async function main() {
  const result = await awardPendingRepostQuests(getArgs());

  if (!result.locked) {
    console.log("Skipped: another repost review worker is already running.");
    return;
  }

  console.log(
    `${result.dryRun ? "Dry run" : "Real run"}: ${result.pendingCount} pending repost quest row(s)`
  );
  console.log(`Quests: ${result.quests.join(", ") || "none"}`);
  if (result.cutoff) {
    console.log(`Cutoff: ${result.cutoff}`);
  }
  console.log(
    `Done. completed=${result.completed} awarded_points=${result.awardedPoints} failed=${result.failed}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

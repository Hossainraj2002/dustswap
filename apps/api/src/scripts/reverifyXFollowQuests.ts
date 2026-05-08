import dotenv from "dotenv";
dotenv.config();

import { supabase } from "../services/supabase";
import {
  getConnectedXUserId,
  xVerificationService,
  type XSocialAccountRecord,
} from "../services/xVerification";

type QuestRow = {
  id: string;
  slug: string;
  title: string;
  rules: Record<string, unknown> | null;
};

type ProgressRow = {
  id: number;
  quest_id: string;
  user_id: number;
  cycle_key: string;
  metadata: Record<string, unknown> | null;
};

type UserRow = {
  id: number;
  address: string;
};

const DEFAULT_SLUGS = ["founderonx", "follow-dustswap-on-x"];

function normalizeLegacyUsername(value: unknown) {
  const username = String(value || "").trim().replace(/^@+/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(username) ? username : null;
}

function getSourceXRef(account: XSocialAccountRecord | null) {
  if (!account) {
    return null;
  }

  const xUserId = getConnectedXUserId(account);
  if (xUserId) {
    return {
      userId: xUserId,
      username: normalizeLegacyUsername(account.username),
      source: "oauth_x_user_id",
    };
  }

  const metadata =
    account.metadata && typeof account.metadata === "object" && !Array.isArray(account.metadata)
      ? account.metadata
      : {};
  const username =
    normalizeLegacyUsername(account.username) ||
    normalizeLegacyUsername(metadata.username) ||
    normalizeLegacyUsername(account.platform_user_id);

  if (!username) {
    return null;
  }

  return {
    userId: null,
    username,
    source: "legacy_username",
  };
}

function getArgs() {
  const args = new Set(process.argv.slice(2));
  return {
    dryRun: args.has("--dry-run"),
    force: args.has("--force"),
  };
}

function getSlugs() {
  return (process.env.X_FOLLOW_REVERIFY_SLUGS || DEFAULT_SLUGS.join(","))
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
}

function getTargetFromQuest(quest: QuestRow) {
  const rules = quest.rules || {};
  const slug = quest.slug.toLowerCase();
  const userIdCandidates = [
    rules.targetXUserId,
    rules.targetUserId,
    rules.target_x_user_id,
    rules.target_user_id,
    slug.includes("founder") ? process.env.FOUNDER_X_USER_ID : null,
    slug.includes("dustswap") ? process.env.DUSTSWAP_X_USER_ID : null,
  ];
  const usernameCandidates = [
    rules.targetXUsername,
    rules.targetUsername,
    rules.target_x_username,
    rules.target_username,
    slug.includes("founder") ? process.env.FOUNDER_X_USERNAME || "akbarx402" : null,
    slug.includes("dustswap") ? process.env.DUSTSWAP_X_USERNAME || "DustswapOnBase" : null,
  ];

  const userId = userIdCandidates
    .map((value) => String(value || "").trim())
    .find((value) => /^\d+$/.test(value));
  const username = usernameCandidates
    .map((value) => String(value || "").trim().replace(/^@+/, ""))
    .find((value) => /^[A-Za-z0-9_]{1,15}$/.test(value));

  if (!userId && !username) {
    throw new Error(`Quest ${quest.slug} is missing target X account rules/env`);
  }

  return {
    userId: userId || null,
    username: username || null,
  };
}

async function getRun(key: string) {
  const { data, error } = await supabase
    .from("app_migration_runs")
    .select("key, ran_at")
    .eq("key", key)
    .maybeSingle();

  if (error) {
    throw new Error(`Load migration run marker: ${error.message}`);
  }

  return data as { key: string; ran_at: string } | null;
}

async function markRun(key: string, metadata: Record<string, unknown>) {
  const { error } = await supabase.from("app_migration_runs").insert({
    key,
    metadata,
  });

  if (error) {
    throw new Error(`Save migration run marker: ${error.message}`);
  }
}

async function main() {
  const { dryRun, force } = getArgs();
  const slugs = getSlugs();
  const runKey = process.env.X_FOLLOW_REVERIFY_RUN_KEY || `x-follow-reverify:${slugs.join("|")}`;

  if (!dryRun && !force) {
    const existingRun = await getRun(runKey);
    if (existingRun) {
      console.log(`Already ran ${runKey} at ${existingRun.ran_at}. Use --force to run again.`);
      return;
    }
  }

  const { data: questsData, error: questsError } = await supabase
    .from("quests")
    .select("id, slug, title, rules")
    .in("slug", slugs)
    .eq("platform", "x")
    .eq("action_type", "follow");

  if (questsError) {
    throw new Error(`Load follow quests: ${questsError.message}`);
  }

  const quests = (questsData || []) as QuestRow[];
  if (quests.length === 0) {
    console.log(`No matching follow quests found for slugs: ${slugs.join(", ")}`);
    return;
  }

  const { data: progressData, error: progressError } = await supabase
    .from("quest_progress")
    .select("id, quest_id, user_id, cycle_key, metadata")
    .in(
      "quest_id",
      quests.map((quest) => quest.id)
    )
    .not("completed_at", "is", null);

  if (progressError) {
    throw new Error(`Load completed follow progress: ${progressError.message}`);
  }

  const progressRows = (progressData || []) as ProgressRow[];
  const userIds = [...new Set(progressRows.map((row) => row.user_id))];

  const [{ data: userData, error: userError }, { data: accountData, error: accountError }] =
    await Promise.all([
      userIds.length
        ? supabase.from("users").select("id, address").in("id", userIds)
        : Promise.resolve({ data: [], error: null }),
      userIds.length
        ? supabase.from("social_accounts").select("*").eq("platform", "x").in("user_id", userIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

  if (userError) {
    throw new Error(`Load users: ${userError.message}`);
  }

  if (accountError) {
    throw new Error(`Load X accounts: ${accountError.message}`);
  }

  const questsById = new Map(quests.map((quest) => [quest.id, quest]));
  const usersById = new Map((userData || []).map((row) => [Number((row as UserRow).id), row as UserRow]));
  const accountsByUserId = new Map(
    ((accountData || []) as XSocialAccountRecord[]).map((row) => [Number(row.user_id), row])
  );

  const stats = {
    checked: 0,
    kept: 0,
    reopened: 0,
    skippedNoXIdentity: 0,
    skippedMissingUser: 0,
    skippedTargetError: 0,
    errors: 0,
  };

  for (const progress of progressRows) {
    const quest = questsById.get(progress.quest_id);
    const user = usersById.get(progress.user_id);
    const account = accountsByUserId.get(progress.user_id) || null;

    if (!quest || !user) {
      stats.skippedMissingUser += 1;
      continue;
    }

    const sourceX = getSourceXRef(account);
    if (!sourceX) {
      stats.skippedNoXIdentity += 1;
      continue;
    }

    let target: { userId: string | null; username: string | null };
    try {
      target = getTargetFromQuest(quest);
    } catch (error) {
      stats.skippedTargetError += 1;
      console.warn((error as Error).message);
      continue;
    }

    try {
      stats.checked += 1;
      const verifiedAt = new Date().toISOString();
      const followCheck = await xVerificationService.checkFollowRelationship(sourceX, target);

      if (followCheck.verified) {
        stats.kept += 1;
        if (!dryRun) {
          const { error } = await supabase
            .from("quest_progress")
            .update({
              verified_by_api: true,
              verified_at: verifiedAt,
              metadata: {
                ...(progress.metadata || {}),
                verified_by_api: true,
                verified_at: verifiedAt,
                verification_provider: "getx",
                one_time_reverify: true,
                source_x_identity_type: sourceX.source,
                source_x_user_id: sourceX.userId || followCheck.sourceUser.id || null,
                source_x_username: followCheck.sourceUser.userName,
                target_x_user_id: followCheck.targetUser.id || null,
                target_x_username: followCheck.targetUser.userName,
              },
              updated_at: verifiedAt,
            })
            .eq("id", progress.id);

          if (error) {
            throw new Error(error.message);
          }
        }
        continue;
      }

      stats.reopened += 1;
      if (!dryRun) {
        const { error } = await supabase
          .from("quest_progress")
          .update({
            status: "not_started",
            progress: 0,
            completed_at: null,
            verified_by_api: false,
            verified_at: null,
            opened_at: null,
            next_verification_at: null,
            metadata: {
              ...(progress.metadata || {}),
              reopened_by_api_reverify: true,
              reverified_at: verifiedAt,
              verification_provider: "getx",
              source_x_identity_type: sourceX.source,
              source_x_user_id: sourceX.userId || followCheck.sourceUser.id || null,
              source_x_username: followCheck.sourceUser.userName,
              target_x_user_id: followCheck.targetUser.id || null,
              target_x_username: followCheck.targetUser.userName,
            },
            updated_at: verifiedAt,
          })
          .eq("id", progress.id);

        if (error) {
          throw new Error(error.message);
        }
      }
    } catch (error) {
      stats.errors += 1;
      console.error(
        `Failed to reverify ${quest.slug} for ${user.address}: ${(error as Error).message}`
      );
    }
  }

  if (!dryRun) {
    await markRun(runKey, {
      slugs,
      stats,
      ranAt: new Date().toISOString(),
    });
  }

  console.log(JSON.stringify({ dryRun, runKey, slugs, stats }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

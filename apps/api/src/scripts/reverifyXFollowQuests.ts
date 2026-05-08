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
const PAGE_SIZE = 1000;
const FOLLOWER_PAGE_LOG_INTERVAL = 25;

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
  const rawArgs = process.argv.slice(2);
  const args = new Set(rawArgs);
  const limitArg = rawArgs.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  return {
    dryRun: args.has("--dry-run"),
    force: args.has("--force"),
    followersList: args.has("--followers-list") || args.has("--bulk-followers"),
    limit: Number.isInteger(limit) && Number(limit) > 0 ? Number(limit) : null,
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

async function fetchAllCompletedProgress(questIds: string[], limit?: number | null) {
  const rows: ProgressRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = limit
      ? Math.min(from + PAGE_SIZE - 1, limit - 1)
      : from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("quest_progress")
      .select("id, quest_id, user_id, cycle_key, metadata")
      .in("quest_id", questIds)
      .not("completed_at", "is", null)
      .range(from, to);

    if (error) {
      throw new Error(`Load completed follow progress: ${error.message}`);
    }

    rows.push(...((data || []) as ProgressRow[]));
    if (!data || data.length < PAGE_SIZE || (limit && rows.length >= limit)) {
      return limit ? rows.slice(0, limit) : rows;
    }
  }
}

async function fetchRowsByUserIds<T extends { user_id?: number; id?: number }>(
  table: string,
  select: string,
  userIds: number[],
  extra?: (query: any) => any
) {
  const rows: T[] = [];
  for (let index = 0; index < userIds.length; index += PAGE_SIZE) {
    const slice = userIds.slice(index, index + PAGE_SIZE);
    let query = supabase.from(table).select(select).in("user_id", slice);
    if (extra) {
      query = extra(query);
    }
    const { data, error } = await query;
    if (error) {
      throw new Error(`Load ${table}: ${error.message}`);
    }
    rows.push(...((data || []) as unknown as T[]));
  }
  return rows;
}

async function fetchUsersByIds(userIds: number[]) {
  const rows: UserRow[] = [];
  for (let index = 0; index < userIds.length; index += PAGE_SIZE) {
    const slice = userIds.slice(index, index + PAGE_SIZE);
    const { data, error } = await supabase
      .from("users")
      .select("id, address")
      .in("id", slice);

    if (error) {
      throw new Error(`Load users: ${error.message}`);
    }
    rows.push(...((data || []) as UserRow[]));
  }
  return rows;
}

function followerKey(value: unknown) {
  return String(value || "").trim().replace(/^@+/, "").toLowerCase();
}

async function buildFollowerSetForQuest(quest: QuestRow) {
  const target = getTargetFromQuest(quest);
  const targetUser =
    target.username
      ? {
          id: target.userId || null,
          userName: target.username,
        }
      : target.userId
        ? await xVerificationService.getUserById(target.userId)
        : null;

  if (!targetUser?.userName) {
    throw new Error(`Quest ${quest.slug} target needs a username for follower-list mode`);
  }

  const usernames = new Set<string>();
  const userIds = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;

  do {
    pages += 1;
    const page = await xVerificationService.getFollowersPage(targetUser.userName, cursor);
    for (const follower of page.followers) {
      const id = String(follower.id || "").trim();
      const username = followerKey(follower.userName || follower.username);
      if (/^\d+$/.test(id)) {
        userIds.add(id);
      }
      if (username) {
        usernames.add(username);
      }
    }

    cursor = page.nextCursor;
    if (pages === 1 || pages % FOLLOWER_PAGE_LOG_INTERVAL === 0 || !page.hasMore) {
      console.log(
        `[followers-list] ${quest.slug}: pages=${pages}, followers_loaded=${Math.max(
          usernames.size,
          userIds.size
        )}`
      );
    }
  } while (cursor);

  return {
    target,
    targetUser,
    usernames,
    userIds,
    pages,
  };
}

function isSourceInFollowerSet(
  sourceX: ReturnType<typeof getSourceXRef>,
  followerSet: Awaited<ReturnType<typeof buildFollowerSetForQuest>>
) {
  if (!sourceX) {
    return false;
  }
  if (sourceX.userId && followerSet.userIds.has(sourceX.userId)) {
    return true;
  }
  const username = followerKey(sourceX.username);
  return Boolean(username && followerSet.usernames.has(username));
}

async function main() {
  const { dryRun, force, followersList, limit } = getArgs();
  const slugs = getSlugs();
  const runMode = followersList ? "followers-list" : "relationship";
  const runKey =
    process.env.X_FOLLOW_REVERIFY_RUN_KEY ||
    `x-follow-reverify:${runMode}:${slugs.join("|")}`;

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

  const progressRows = await fetchAllCompletedProgress(
    quests.map((quest) => quest.id),
    limit
  );
  const userIds = [...new Set(progressRows.map((row) => row.user_id))];

  const [userData, accountData] = userIds.length
    ? await Promise.all([
        fetchUsersByIds(userIds),
        fetchRowsByUserIds<XSocialAccountRecord>(
          "social_accounts",
          "*",
          userIds,
          (query) => query.eq("platform", "x")
        ),
      ])
    : [[], []];

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
    followerPages: 0,
  };

  const followerSetsByQuestId = new Map<
    string,
    Awaited<ReturnType<typeof buildFollowerSetForQuest>>
  >();
  if (followersList) {
    for (const quest of quests) {
      try {
        const followerSet = await buildFollowerSetForQuest(quest);
        followerSetsByQuestId.set(quest.id, followerSet);
        stats.followerPages += followerSet.pages;
      } catch (error) {
        stats.skippedTargetError += 1;
        console.warn((error as Error).message);
      }
    }
  }

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
      const followerSet = followersList ? followerSetsByQuestId.get(quest.id) : null;
      const followCheck = followerSet
        ? {
            verified: isSourceInFollowerSet(sourceX, followerSet),
            sourceUser: {
              id: sourceX.userId || "",
              userName: sourceX.username || "",
            },
            targetUser: {
              id: followerSet.target.userId || followerSet.targetUser.id || "",
              userName: followerSet.targetUser.userName,
            },
            raw: {
              verificationMode: "followers-list",
            },
          }
        : await xVerificationService.checkFollowRelationship(sourceX, target);

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
      mode: runMode,
      stats,
      ranAt: new Date().toISOString(),
    });
  }

  console.log(JSON.stringify({ dryRun, runKey, slugs, mode: runMode, limit, stats }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

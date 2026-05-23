import "dotenv/config";

import { once } from "node:events";
import {
  Client,
  Events,
  GatewayIntentBits,
  type GuildMember,
  type Message,
} from "discord.js";
import {
  CAMPAIGN_NAME,
  applyClaimSuccessToState,
  buildClaimSuccessLog,
  formatDiscordUser,
  getRoleAssignmentStatus,
  initializeState,
  isUnknownMemberError,
  loadConfig,
  normalizeTweetLink,
  type ParsedClaimSuccess,
  type RuntimeState,
} from "../bots/earlyContributorBotCore";

type CliOptions = {
  apply: boolean;
  limit: number | null;
};

type BackfillStats = {
  scannedMessages: number;
  validSubmissionMessages: number;
  skippedAlreadyClaimedUser: number;
  skippedAlreadyClaimedTweet: number;
  skippedNotInGuild: number;
  skippedClaimCap: number;
  roleAssignments: number;
  reconstructedLogs: number;
  failedRoleAssignments: number;
  failedLogWrites: number;
};

function logInfo(message: string) {
  console.log(`[Early Contributor Backfill] ${message}`);
}

function logWarn(message: string) {
  console.warn(`[Early Contributor Backfill] ${message}`);
}

function parseArgs(argv: string[]): CliOptions {
  let apply = false;
  let limit: number | null = null;

  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
      continue;
    }

    if (arg === "--help") {
      console.log(`
One-time Early Contributor backfill

Dry run:
  pnpm backfill:early-bot

Apply:
  pnpm backfill:early-bot -- --apply

Optional:
  --limit=<number>   Stop after this many successful backfilled claims/reconstructed logs
`);
      process.exit(0);
    }

    if (arg.startsWith("--limit=")) {
      const parsed = Number.parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error("limit must be a positive integer");
      }
      limit = parsed;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { apply, limit };
}

async function createDiscordClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  client.on(Events.Error, (error: Error) => {
    console.error("[Early Contributor Backfill] Client error:", error);
  });

  client.on(Events.Warn, (warning: string) => {
    console.warn("[Early Contributor Backfill] Client warning:", warning);
  });

  return client;
}

async function loginReadyClient(client: Client, token: string) {
  const readyPromise = once(client, Events.ClientReady) as Promise<[Client<true>]>;
  await client.login(token);
  const [readyClient] = await readyPromise;
  return readyClient;
}

async function loadSubmitChannelMessages(state: RuntimeState) {
  const allMessages: Message[] = [];
  let before: string | undefined;

  while (true) {
    const batch = await state.submitChannel.messages.fetch({
      limit: 100,
      before,
    });

    if (batch.size === 0) {
      break;
    }

    allMessages.push(...batch.values());
    before = batch.last()?.id;

    if (!before) {
      break;
    }
  }

  return allMessages.reverse();
}

async function fetchMemberOrNull(state: RuntimeState, userId: string) {
  return state.guild.members.fetch(userId).catch((error: unknown) => {
    if (isUnknownMemberError(error)) {
      return null;
    }
    throw error;
  });
}

function buildClaimRecord(args: {
  state: RuntimeState;
  message: Message;
  claimNumber: number;
  timestamp: string;
}) {
  const normalizedTweet = normalizeTweetLink(args.message.content);
  if (!normalizedTweet) {
    return null;
  }

  return {
    claim: {
      discordUserId: args.message.author.id,
      discordUser: formatDiscordUser(args.message.author),
      tweetId: normalizedTweet.tweetId,
      tweetUrl: normalizedTweet.tweetUrl,
      roleId: args.state.role.id,
      claimNumber: args.claimNumber,
      maxClaims: args.state.config.maxClaims,
      timestamp: args.timestamp,
    } satisfies ParsedClaimSuccess,
    normalizedTweet,
  };
}

async function runBackfill(state: RuntimeState, options: CliOptions) {
  const stats: BackfillStats = {
    scannedMessages: 0,
    validSubmissionMessages: 0,
    skippedAlreadyClaimedUser: 0,
    skippedAlreadyClaimedTweet: 0,
    skippedNotInGuild: 0,
    skippedClaimCap: 0,
    roleAssignments: 0,
    reconstructedLogs: 0,
    failedRoleAssignments: 0,
    failedLogWrites: 0,
  };

  const submitMessages = await loadSubmitChannelMessages(state);
  logInfo(`Loaded ${submitMessages.length} historical message(s) from the submit channel.`);

  for (const message of submitMessages) {
    if (options.limit !== null && stats.roleAssignments + stats.reconstructedLogs >= options.limit) {
      logInfo(`Reached --limit=${options.limit}. Stopping early.`);
      break;
    }

    stats.scannedMessages += 1;

    if (message.author.bot) {
      continue;
    }

    const normalizedTweet = normalizeTweetLink(message.content);
    if (!normalizedTweet) {
      continue;
    }

    stats.validSubmissionMessages += 1;

    if (state.claimedDiscordUserIds.has(message.author.id)) {
      stats.skippedAlreadyClaimedUser += 1;
      continue;
    }

    if (state.claimedTweetIds.has(normalizedTweet.tweetId)) {
      stats.skippedAlreadyClaimedTweet += 1;
      continue;
    }

    if (state.successfulClaimCount >= state.config.maxClaims) {
      stats.skippedClaimCap += 1;
      logWarn(
        `Claim cap already reached at ${state.successfulClaimCount}/${state.config.maxClaims}.`
      );
      break;
    }

    const member = await fetchMemberOrNull(state, message.author.id);
    if (!member) {
      stats.skippedNotInGuild += 1;
      continue;
    }

    const claimNumber = state.successfulClaimCount + 1;
    const claimRecord = buildClaimRecord({
      state,
      message,
      claimNumber,
      timestamp: message.createdAt.toISOString(),
    });

    if (!claimRecord) {
      continue;
    }

    const alreadyHasRole = member.roles.cache.has(state.role.id);

    if (!options.apply) {
      applyClaimSuccessToState(state, `dry-run:${message.id}`, claimRecord.claim);
      if (alreadyHasRole) {
        stats.reconstructedLogs += 1;
      } else {
        stats.roleAssignments += 1;
      }
      continue;
    }

    if (!alreadyHasRole) {
      try {
        await member.roles.add(
          state.role.id,
          `${CAMPAIGN_NAME} backfill #${claimNumber}/${state.config.maxClaims}`
        );
      } catch (error) {
        stats.failedRoleAssignments += 1;
        console.error(
          `[Early Contributor Backfill] Failed to assign role to user ${member.id} from message ${message.id}:`,
          error
        );
        continue;
      }
    }

    try {
      const logMessage = await state.logChannel.send(
        buildClaimSuccessLog(claimRecord.claim)
      );
      applyClaimSuccessToState(state, logMessage.id, claimRecord.claim);

      if (alreadyHasRole) {
        stats.reconstructedLogs += 1;
      } else {
        stats.roleAssignments += 1;
      }
    } catch (error) {
      stats.failedLogWrites += 1;
      console.error(
        `[Early Contributor Backfill] Failed to write claim log for message ${message.id}:`,
        error
      );

      if (!alreadyHasRole) {
        try {
          await member.roles.remove(
            state.role.id,
            "Rollback because backfill claim log write failed"
          );
        } catch (rollbackError) {
          console.error(
            `[Early Contributor Backfill] Failed to roll back role ${state.role.id} for user ${member.id}:`,
            rollbackError
          );
        }
      }
    }
  }

  return stats;
}

function printSummary(stats: BackfillStats, options: CliOptions, state: RuntimeState) {
  logInfo(`${options.apply ? "Apply run" : "Dry run"} complete.`);
  logInfo(`Scanned submit messages: ${stats.scannedMessages}`);
  logInfo(`Valid X/Twitter submissions: ${stats.validSubmissionMessages}`);
  logInfo(`Skipped already-claimed users: ${stats.skippedAlreadyClaimedUser}`);
  logInfo(`Skipped already-used tweets: ${stats.skippedAlreadyClaimedTweet}`);
  logInfo(`Skipped users no longer in guild: ${stats.skippedNotInGuild}`);
  if (stats.skippedClaimCap > 0) {
    logWarn(`Stopped because the campaign hit its max claim cap.`);
  }
  logInfo(
    `${options.apply ? "Role assignments written" : "Dry-run role assignments"}: ${stats.roleAssignments}`
  );
  logInfo(
    `${options.apply ? "Missing logs reconstructed" : "Dry-run log reconstructions"}: ${stats.reconstructedLogs}`
  );
  logInfo(`Role assignment failures: ${stats.failedRoleAssignments}`);
  logInfo(`Claim log write failures: ${stats.failedLogWrites}`);
  logInfo(
    `Resulting successful claim count: ${state.successfulClaimCount}/${state.config.maxClaims}`
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig({ logPrefix: "[Early Contributor Backfill]" });

  logInfo(
    `${options.apply ? "Apply mode" : "Dry run"} started for guild=${config.guildId}, submit=${config.submitChannelId}, log=${config.logChannelId}, role=${config.roleId}`
  );

  const client = await createDiscordClient();

  try {
    const readyClient = await loginReadyClient(client, config.botToken);
    const state = await initializeState(readyClient, config);
    const roleStatus = await getRoleAssignmentStatus(state.guild, state.role);

    if (!roleStatus.roleIsAssignable) {
      throw new Error(
        `Bot cannot assign role ${state.role.id}. Check Manage Roles permission and role order.`
      );
    }

    logInfo(
      `Existing successful claims loaded: ${state.successfulClaimCount}/${state.config.maxClaims}`
    );

    const stats = await runBackfill(state, options);
    printSummary(stats, options, state);
  } finally {
    await client.destroy();
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("[Early Contributor Backfill] Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[Early Contributor Backfill] Uncaught exception:", error);
});

void main().catch((error) => {
  console.error(
    `[Early Contributor Backfill] ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});

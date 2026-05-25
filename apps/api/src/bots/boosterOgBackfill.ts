import "dotenv/config";

import { once } from "node:events";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  type Channel,
  type Guild,
  type GuildMember,
  type Role,
  type TextChannel,
} from "discord.js";
import { formatDiscordUser, getRoleAssignmentStatus } from "./earlyContributorBotCore";
import {
  BOOSTER_OG_BACKFILL_GRANTED_REASON,
  BOOSTER_OG_CAMPAIGN_NAME,
  BOOSTER_OG_GRANTED_HEADER,
  isServerBooster,
  loadBoosterOgConfig,
  loadBoosterOgManagedUsersFromLog,
  type BoosterOgConfig,
} from "./boosterOgRole";

type BackfillOptions = {
  dryRun: boolean;
  limit: number | null;
};

type BackfillSummary = {
  totalMembersScanned: number;
  currentBoostersFound: number;
  boostersAlreadyHadOg: number;
  ogRolesAdded: number;
  grantLogsWritten: number;
  skippedDuplicateGrantLogs: number;
  errors: number;
};

function logInfo(message: string) {
  console.log(`[Booster OG Backfill] ${message}`);
}

function logWarn(message: string) {
  console.warn(`[Booster OG Backfill] ${message}`);
}

function parseBackfillOptions(): BackfillOptions {
  const dryRunRaw = process.env.DISCORD_BOOSTER_OG_BACKFILL_DRY_RUN?.trim().toLowerCase();
  const dryRun = !dryRunRaw || ["1", "true", "yes", "on"].includes(dryRunRaw);

  if (dryRunRaw && !["1", "true", "yes", "on", "0", "false", "no", "off"].includes(dryRunRaw)) {
    throw new Error("DISCORD_BOOSTER_OG_BACKFILL_DRY_RUN must be a boolean-like value.");
  }

  const limitRaw = process.env.DISCORD_BOOSTER_OG_BACKFILL_LIMIT?.trim();
  if (!limitRaw) {
    return {
      dryRun,
      limit: null,
    };
  }

  const parsed = Number.parseInt(limitRaw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("DISCORD_BOOSTER_OG_BACKFILL_LIMIT must be a positive integer.");
  }

  return {
    dryRun,
    limit: parsed,
  };
}

function assertGuildTextChannel(
  channel: Channel | null,
  channelId: string,
  guildId: string,
  label: string
) {
  if (!channel) {
    throw new Error(`${label} not found: ${channelId}`);
  }

  if (channel.type !== ChannelType.GuildText) {
    throw new Error(`${label} must be a guild text channel: ${channelId}`);
  }

  if (channel.guildId !== guildId) {
    throw new Error(`${label} ${channelId} does not belong to guild ${guildId}.`);
  }

  return channel as TextChannel;
}

async function delay(ms: number) {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBackfillGrantLog(member: GuildMember, config: BoosterOgConfig, timestamp: string) {
  return [
    BOOSTER_OG_GRANTED_HEADER,
    `Campaign: ${BOOSTER_OG_CAMPAIGN_NAME}`,
    `Discord ID: ${member.id}`,
    `Discord User: ${formatDiscordUser(member.user)}`,
    `OG Role ID: ${config.boosterOgRoleId}`,
    `Server Booster Role ID: ${config.serverBoosterRoleId}`,
    `Reason: ${BOOSTER_OG_BACKFILL_GRANTED_REASON}`,
    `Time: ${timestamp}`,
  ].join("\n");
}

async function createReadyClient(token: string) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  client.on(Events.Error, (error: Error) => {
    console.error("[Booster OG Backfill] Client error:", error);
  });

  client.on(Events.Warn, (warning: string) => {
    console.warn("[Booster OG Backfill] Client warning:", warning);
  });

  const readyPromise = once(client, Events.ClientReady) as Promise<[Client<true>]>;
  await client.login(token);
  const [readyClient] = await readyPromise;
  return readyClient;
}

async function loadBackfillResources(client: Client<true>, config: BoosterOgConfig) {
  const guild = await client.guilds.fetch(config.guildId);
  const logChannel = assertGuildTextChannel(
    await client.channels.fetch(config.logChannelId),
    config.logChannelId,
    guild.id,
    "Booster OG log channel"
  );
  const ogRole = await guild.roles.fetch(config.boosterOgRoleId);
  const serverBoosterRole = await guild.roles.fetch(config.serverBoosterRoleId);

  if (!ogRole) {
    throw new Error(`Custom OG role not found: ${config.boosterOgRoleId}`);
  }

  config.logChannel = logChannel;
  config.boosterOgRole = ogRole;
  config.serverBoosterRole = serverBoosterRole ?? null;

  return {
    guild,
    logChannel,
    ogRole,
    serverBoosterRole: serverBoosterRole ?? null,
  };
}

async function assertBackfillPermissions(
  guild: Guild,
  logChannel: TextChannel,
  ogRole: Role
) {
  const roleStatus = await getRoleAssignmentStatus(guild, ogRole);
  const logPermissions = roleStatus.botMember.permissionsIn(logChannel);
  const canUseLogChannel =
    logPermissions.has(PermissionFlagsBits.ViewChannel) &&
    logPermissions.has(PermissionFlagsBits.SendMessages) &&
    logPermissions.has(PermissionFlagsBits.ReadMessageHistory);

  if (!roleStatus.canManageRoles) {
    throw new Error("Bot is missing Manage Roles permission.");
  }

  if (!roleStatus.roleIsBelowBot) {
    throw new Error(`Custom OG role ${ogRole.id} is not below the bot's highest role.`);
  }

  if (!canUseLogChannel) {
    throw new Error(
      `Bot cannot view/send/read history in booster OG log channel ${logChannel.id}.`
    );
  }
}

async function runBackfill(
  guild: Guild,
  config: BoosterOgConfig,
  managedSet: Set<string>,
  options: BackfillOptions
) {
  const summary: BackfillSummary = {
    totalMembersScanned: 0,
    currentBoostersFound: 0,
    boostersAlreadyHadOg: 0,
    ogRolesAdded: 0,
    grantLogsWritten: 0,
    skippedDuplicateGrantLogs: 0,
    errors: 0,
  };

  const members = await guild.members.fetch();
  for (const member of members.values()) {
    summary.totalMembersScanned += 1;

    if (!isServerBooster(member, config)) {
      continue;
    }

    summary.currentBoostersFound += 1;

    const hasOg = member.roles.cache.has(config.boosterOgRoleId);
    if (hasOg) {
      summary.boostersAlreadyHadOg += 1;
      continue;
    }

    if (options.limit !== null && summary.ogRolesAdded >= options.limit) {
      logInfo(`Reached backfill limit ${options.limit}. Stopping early.`);
      break;
    }

    const alreadyManaged = managedSet.has(member.id);
    const wouldSkipDuplicateLog = alreadyManaged;
    const timestamp = new Date().toISOString();

    if (options.dryRun) {
      summary.ogRolesAdded += 1;
      if (wouldSkipDuplicateLog) {
        summary.skippedDuplicateGrantLogs += 1;
        logInfo(`Dry run: would add OG to booster ${member.id} and skip duplicate grant log.`);
      } else {
        summary.grantLogsWritten += 1;
        logInfo(`Dry run: would add OG to booster ${member.id} and write grant log.`);
      }
      continue;
    }

    try {
      await member.roles.add(
        config.boosterOgRoleId,
        `${BOOSTER_OG_CAMPAIGN_NAME}: ${BOOSTER_OG_BACKFILL_GRANTED_REASON}`
      );
      summary.ogRolesAdded += 1;
      await delay(config.actionDelayMs);
    } catch (error) {
      summary.errors += 1;
      console.error(`[Booster OG Backfill] Failed to add OG role for member ${member.id}:`, error);
      continue;
    }

    if (wouldSkipDuplicateLog) {
      summary.skippedDuplicateGrantLogs += 1;
      logInfo(`Added OG to current booster user ID: ${member.id} (duplicate grant log skipped)`);
      continue;
    }

    try {
      await config.logChannel!.send(buildBackfillGrantLog(member, config, timestamp));
      managedSet.add(member.id);
      summary.grantLogsWritten += 1;
      logInfo(`Added OG to current booster user ID: ${member.id}`);
      await delay(config.actionDelayMs);
    } catch (error) {
      summary.errors += 1;
      console.error(
        `[Booster OG Backfill] Failed to write BOOSTER_OG_GRANTED log for member ${member.id}:`,
        error
      );

      try {
        await member.roles.remove(
          config.boosterOgRoleId,
          "Rollback because BOOSTER_OG_GRANTED backfill log write failed"
        );
        summary.ogRolesAdded -= 1;
      } catch (rollbackError) {
        console.error(
          `[Booster OG Backfill] Failed to roll back OG role for member ${member.id}:`,
          rollbackError
        );
      }
    }
  }

  return summary;
}

async function main() {
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required.");
  }

  const config = loadBoosterOgConfig({ logPrefix: "[Booster OG Backfill]" });
  const options = parseBackfillOptions();
  logInfo(
    `Starting booster OG backfill. dry_run=${options.dryRun} limit=${options.limit ?? "none"}`
  );

  const client = await createReadyClient(botToken);

  try {
    const { guild, logChannel, ogRole, serverBoosterRole } = await loadBackfillResources(
      client,
      config
    );

    logInfo(`Guild loaded: ${guild.id}`);
    logInfo(`Booster OG log channel loaded: ${logChannel.name} (${logChannel.id})`);
    logInfo(`Custom OG role loaded: ${ogRole.name} (${ogRole.id})`);
    if (serverBoosterRole) {
      logInfo(
        `Server Booster role loaded/readable: ${serverBoosterRole.name} (${serverBoosterRole.id})`
      );
    } else {
      logWarn(
        `Server Booster role ${config.serverBoosterRoleId} could not be fetched by name, but booster detection will still use member role IDs and premiumSince.`
      );
    }

    await assertBackfillPermissions(guild, logChannel, ogRole);
    const managedSet = await loadBoosterOgManagedUsersFromLog(config);
    logInfo(`Loaded existing bot-managed booster OG users: ${managedSet.size}`);

    const summary = await runBackfill(guild, config, managedSet, options);
    logInfo(`Backfill complete.`);
    logInfo(`Total members scanned: ${summary.totalMembersScanned}`);
    logInfo(`Total current boosters found: ${summary.currentBoostersFound}`);
    logInfo(`Boosters who already had OG and were ignored: ${summary.boostersAlreadyHadOg}`);
    logInfo(`OG roles added: ${summary.ogRolesAdded}`);
    logInfo(`Grant logs written: ${summary.grantLogsWritten}`);
    logInfo(`Skipped duplicate grant logs: ${summary.skippedDuplicateGrantLogs}`);
    logInfo(`Errors: ${summary.errors}`);
    logInfo(`Dry run: ${options.dryRun}`);
  } finally {
    await client.destroy();
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("[Booster OG Backfill] Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[Booster OG Backfill] Uncaught exception:", error);
});

void main().catch((error) => {
  console.error(
    `[Booster OG Backfill] ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});

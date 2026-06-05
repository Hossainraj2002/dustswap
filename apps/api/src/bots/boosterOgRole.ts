import {
  ChannelType,
  Events,
  PermissionFlagsBits,
  type Channel,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type Role,
  type TextChannel,
} from "discord.js";
import { formatDiscordUser, getRoleAssignmentStatus } from "./earlyContributorBotCore";

export const BOOSTER_OG_CAMPAIGN_NAME = "Server Booster OG";
export const BOOSTER_OG_GRANTED_HEADER = "BOOSTER_OG_GRANTED";
export const BOOSTER_OG_REMOVED_HEADER = "BOOSTER_OG_REMOVED";
export const BOOSTER_OG_GRANTED_REASON = "User is boosting and did not already have OG";
export const BOOSTER_OG_BACKFILL_GRANTED_REASON =
  "Current booster backfill - user is boosting and did not already have OG";
export const BOOSTER_OG_REMOVED_REASON = "User stopped boosting and OG was bot-managed";
const DEFAULT_BOOSTER_OG_SYNC_INTERVAL_MINUTES = 30;
const DEFAULT_BOOSTER_OG_MAX_ACTIVE_GRANTS = 25;
const DEFAULT_ACTION_DELAY_MS = 350;

const DEFAULT_BOOSTER_OG_CONFIG = {
  guildId: "1494584551630962808",
  serverBoosterRoleId: "1496260996627562628",
  boosterOgRoleId: "1495670561332789289",
  logChannelId: "1508507311323218082",
  syncOnStart: true,
  syncIntervalMinutes: DEFAULT_BOOSTER_OG_SYNC_INTERVAL_MINUTES,
  maxActiveGrants: DEFAULT_BOOSTER_OG_MAX_ACTIVE_GRANTS,
  debug: false,
  actionDelayMs: DEFAULT_ACTION_DELAY_MS,
} as const;

const BOOSTER_OG_GRANTED_REGEX =
  /^BOOSTER_OG_GRANTED\r?\nCampaign: Server Booster OG\r?\nDiscord ID: (?<discordUserId>\d+)\r?\nDiscord User: (?<discordUser>[^\r\n]+)\r?\nOG Role ID: (?<ogRoleId>\d+)\r?\nServer Booster Role ID: (?<serverBoosterRoleId>\d+)\r?\nReason: (?<reason>User is boosting and did not already have OG|Current booster backfill - user is boosting and did not already have OG)\r?\nTime: (?<timestamp>[^\r\n]+)$/;

const BOOSTER_OG_REMOVED_REGEX =
  /^BOOSTER_OG_REMOVED\r?\nCampaign: Server Booster OG\r?\nDiscord ID: (?<discordUserId>\d+)\r?\nDiscord User: (?<discordUser>[^\r\n]+)\r?\nOG Role ID: (?<ogRoleId>\d+)\r?\nServer Booster Role ID: (?<serverBoosterRoleId>\d+)\r?\nReason: User stopped boosting and OG was bot-managed\r?\nTime: (?<timestamp>[^\r\n]+)$/;

type BoosterOgLogType = "granted" | "removed";

type BoosterOgLogRecord = {
  type: BoosterOgLogType;
  discordUserId: string;
  discordUser: string;
  ogRoleId: string;
  serverBoosterRoleId: string;
  timestamp: string;
};

type LoadBoosterOgConfigOptions = {
  logPrefix?: string;
};

export type BoosterOgConfig = {
  guildId: string;
  serverBoosterRoleId: string;
  boosterOgRoleId: string;
  logChannelId: string;
  syncOnStart: boolean;
  syncIntervalMinutes: number;
  maxActiveGrants: number;
  debug: boolean;
  actionDelayMs: number;
  logChannel: TextChannel | null;
  boosterOgRole: Role | null;
  serverBoosterRole: Role | null;
};

export type BoosterOgReconcileAction =
  | "none"
  | "granted"
  | "removed"
  | "skipped-not-managed"
  | "skipped-permissions"
  | "skipped-log-channel"
  | "skipped-cap"
  | "error";

export type BoosterOgReconcileResult = {
  action: BoosterOgReconcileAction;
  memberId: string;
};

export type BoosterOgSyncSummary = {
  scanned: number;
  granted: number;
  removed: number;
  skippedNotManaged: number;
  skippedCap: number;
  errors: number;
};

function logInfo(message: string) {
  console.log(`[Booster OG] ${message}`);
}

function logWarn(message: string) {
  console.warn(`[Booster OG] ${message}`);
}

function logDebug(config: BoosterOgConfig, message: string) {
  if (config.debug) {
    console.log(`[Booster OG][debug] ${message}`);
  }
}

function warnWithPrefix(logPrefix: string | undefined, message: string) {
  if (logPrefix) {
    console.warn(`${logPrefix} ${message}`);
    return;
  }

  console.warn(message);
}

function parseBooleanEnv(name: string, defaultValue: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  throw new Error(`${name} must be a boolean-like value.`);
}

function parseIntegerEnv(name: string, defaultValue: number, minValue: number) {
  const value = process.env[name]?.trim();
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minValue) {
    throw new Error(`${name} must be an integer >= ${minValue}.`);
  }

  return parsed;
}

function readStringEnv(
  name: string,
  fallback: string | undefined,
  options: LoadBoosterOgConfigOptions
) {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }

  if (fallback !== undefined) {
    warnWithPrefix(options.logPrefix, `${name} not set. Using default ${fallback}.`);
    return fallback;
  }

  throw new Error(`${name} is required.`);
}

function validateSnowflake(name: string, value: string) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a Discord snowflake.`);
  }
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

function buildBoosterOgGrantLog(member: GuildMember, config: BoosterOgConfig, timestamp: string) {
  return [
    BOOSTER_OG_GRANTED_HEADER,
    `Campaign: ${BOOSTER_OG_CAMPAIGN_NAME}`,
    `Discord ID: ${member.id}`,
    `Discord User: ${formatDiscordUser(member.user)}`,
    `OG Role ID: ${config.boosterOgRoleId}`,
    `Server Booster Role ID: ${config.serverBoosterRoleId}`,
    `Reason: ${BOOSTER_OG_GRANTED_REASON}`,
    `Time: ${timestamp}`,
  ].join("\n");
}

function buildBoosterOgRemovedLog(member: GuildMember, config: BoosterOgConfig, timestamp: string) {
  return [
    BOOSTER_OG_REMOVED_HEADER,
    `Campaign: ${BOOSTER_OG_CAMPAIGN_NAME}`,
    `Discord ID: ${member.id}`,
    `Discord User: ${formatDiscordUser(member.user)}`,
    `OG Role ID: ${config.boosterOgRoleId}`,
    `Server Booster Role ID: ${config.serverBoosterRoleId}`,
    `Reason: ${BOOSTER_OG_REMOVED_REASON}`,
    `Time: ${timestamp}`,
  ].join("\n");
}

function parseBoosterOgLog(content: string): BoosterOgLogRecord | null {
  const grantedMatch = content.match(BOOSTER_OG_GRANTED_REGEX);
  if (grantedMatch?.groups) {
    return {
      type: "granted",
      discordUserId: grantedMatch.groups.discordUserId,
      discordUser: grantedMatch.groups.discordUser,
      ogRoleId: grantedMatch.groups.ogRoleId,
      serverBoosterRoleId: grantedMatch.groups.serverBoosterRoleId,
      timestamp: grantedMatch.groups.timestamp,
    };
  }

  const removedMatch = content.match(BOOSTER_OG_REMOVED_REGEX);
  if (removedMatch?.groups) {
    return {
      type: "removed",
      discordUserId: removedMatch.groups.discordUserId,
      discordUser: removedMatch.groups.discordUser,
      ogRoleId: removedMatch.groups.ogRoleId,
      serverBoosterRoleId: removedMatch.groups.serverBoosterRoleId,
      timestamp: removedMatch.groups.timestamp,
    };
  }

  return null;
}

function applyBoosterOgLogToManagedSet(
  managedSet: Set<string>,
  record: BoosterOgLogRecord,
  config: BoosterOgConfig
) {
  if (
    record.ogRoleId !== config.boosterOgRoleId ||
    record.serverBoosterRoleId !== config.serverBoosterRoleId
  ) {
    return;
  }

  if (record.type === "granted") {
    managedSet.add(record.discordUserId);
    return;
  }

  managedSet.delete(record.discordUserId);
}

async function delay(ms: number) {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureBoosterOgRuntimeResources(guild: Guild, config: BoosterOgConfig) {
  if (
    config.logChannel &&
    config.logChannel.id === config.logChannelId &&
    config.boosterOgRole &&
    config.boosterOgRole.id === config.boosterOgRoleId
  ) {
    return {
      logChannel: config.logChannel,
      boosterOgRole: config.boosterOgRole,
      serverBoosterRole: config.serverBoosterRole,
    };
  }

  const logChannel = assertGuildTextChannel(
    await guild.client.channels.fetch(config.logChannelId),
    config.logChannelId,
    guild.id,
    "Booster OG log channel"
  );
  const boosterOgRole = await guild.roles.fetch(config.boosterOgRoleId);
  const serverBoosterRole = await guild.roles.fetch(config.serverBoosterRoleId);

  if (!boosterOgRole) {
    throw new Error(`Custom OG role not found: ${config.boosterOgRoleId}`);
  }

  config.logChannel = logChannel;
  config.boosterOgRole = boosterOgRole;
  config.serverBoosterRole = serverBoosterRole ?? null;

  return {
    logChannel,
    boosterOgRole,
    serverBoosterRole: serverBoosterRole ?? null,
  };
}

async function ensureBoosterOgOperationalStatus(guild: Guild, config: BoosterOgConfig) {
  const resources = await ensureBoosterOgRuntimeResources(guild, config);
  const roleStatus = await getRoleAssignmentStatus(guild, resources.boosterOgRole);
  const logChannelPermissions = roleStatus.botMember.permissionsIn(resources.logChannel);

  const canUseLogChannel =
    logChannelPermissions.has(PermissionFlagsBits.ViewChannel) &&
    logChannelPermissions.has(PermissionFlagsBits.SendMessages) &&
    logChannelPermissions.has(PermissionFlagsBits.ReadMessageHistory);

  return {
    ...resources,
    roleStatus,
    canUseLogChannel,
  };
}

export function loadBoosterOgConfig(
  options: LoadBoosterOgConfigOptions = {}
): BoosterOgConfig {
  const guildId = readStringEnv("DISCORD_GUILD_ID", DEFAULT_BOOSTER_OG_CONFIG.guildId, options);
  const serverBoosterRoleId = readStringEnv(
    "DISCORD_SERVER_BOOSTER_ROLE_ID",
    DEFAULT_BOOSTER_OG_CONFIG.serverBoosterRoleId,
    options
  );
  const boosterOgRoleId = readStringEnv(
    "DISCORD_BOOSTER_OG_ROLE_ID",
    DEFAULT_BOOSTER_OG_CONFIG.boosterOgRoleId,
    options
  );
  const logChannelId = readStringEnv(
    "DISCORD_BOOSTER_OG_LOG_CHANNEL_ID",
    DEFAULT_BOOSTER_OG_CONFIG.logChannelId,
    options
  );

  validateSnowflake("DISCORD_GUILD_ID", guildId);
  validateSnowflake("DISCORD_SERVER_BOOSTER_ROLE_ID", serverBoosterRoleId);
  validateSnowflake("DISCORD_BOOSTER_OG_ROLE_ID", boosterOgRoleId);
  validateSnowflake("DISCORD_BOOSTER_OG_LOG_CHANNEL_ID", logChannelId);

  return {
    guildId,
    serverBoosterRoleId,
    boosterOgRoleId,
    logChannelId,
    syncOnStart: parseBooleanEnv(
      "DISCORD_BOOSTER_OG_SYNC_ON_START",
      DEFAULT_BOOSTER_OG_CONFIG.syncOnStart
    ),
    syncIntervalMinutes: parseIntegerEnv(
      "DISCORD_BOOSTER_OG_SYNC_INTERVAL_MINUTES",
      DEFAULT_BOOSTER_OG_CONFIG.syncIntervalMinutes,
      0
    ),
    maxActiveGrants: parseIntegerEnv(
      "DISCORD_BOOSTER_OG_MAX_ACTIVE_GRANTS",
      DEFAULT_BOOSTER_OG_CONFIG.maxActiveGrants,
      1
    ),
    debug: parseBooleanEnv("DISCORD_BOOSTER_OG_DEBUG", DEFAULT_BOOSTER_OG_CONFIG.debug),
    actionDelayMs: DEFAULT_BOOSTER_OG_CONFIG.actionDelayMs,
    logChannel: null,
    boosterOgRole: null,
    serverBoosterRole: null,
  };
}

export async function loadBoosterOgManagedUsersFromLog(config: BoosterOgConfig) {
  if (!config.logChannel) {
    throw new Error("Booster OG log channel must be loaded before reading managed users.");
  }

  const allMessages: Message[] = [];
  let before: string | undefined;

  while (true) {
    const batch = await config.logChannel.messages.fetch({
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

  const managedSet = new Set<string>();
  for (const message of allMessages.reverse()) {
    const parsed = parseBoosterOgLog(message.content);
    if (!parsed) {
      continue;
    }

    applyBoosterOgLogToManagedSet(managedSet, parsed, config);
  }

  return managedSet;
}

export function isServerBooster(member: GuildMember, config: BoosterOgConfig) {
  return Boolean(member.premiumSince) || member.roles.cache.has(config.serverBoosterRoleId);
}

export async function reconcileBoosterOgRoleForMember(
  member: GuildMember,
  config: BoosterOgConfig,
  managedSet: Set<string>
): Promise<BoosterOgReconcileResult> {
  try {
    const { logChannel, roleStatus, canUseLogChannel } = await ensureBoosterOgOperationalStatus(
      member.guild,
      config
    );

    if (!roleStatus.roleIsAssignable) {
      logWarn(`Permission warning: bot cannot manage OG role ${config.boosterOgRoleId}.`);
      return { action: "skipped-permissions", memberId: member.id };
    }

    if (!canUseLogChannel) {
      logWarn(
        `Permission warning: bot cannot view/send/read history in OG log channel ${config.logChannelId}.`
      );
      return { action: "skipped-log-channel", memberId: member.id };
    }

    const boosting = isServerBooster(member, config);
    const hasOg = member.roles.cache.has(config.boosterOgRoleId);
    const managedByBot = managedSet.has(member.id);

    logDebug(
      config,
          `Reconciling member ${member.id}: boosting=${boosting} hasOg=${hasOg} managed=${managedByBot}`
    );

    if (boosting && !hasOg) {
      if (!managedByBot && managedSet.size >= config.maxActiveGrants) {
        logInfo(
          `Skipped OG grant for booster user ID: ${member.id}; bot-managed cap reached (${managedSet.size}/${config.maxActiveGrants})`
        );
        return { action: "skipped-cap", memberId: member.id };
      }

      const timestamp = new Date().toISOString();
      try {
        await member.roles.add(
          config.boosterOgRoleId,
          `${BOOSTER_OG_CAMPAIGN_NAME}: ${BOOSTER_OG_GRANTED_REASON}`
        );
      } catch (error) {
        console.error(`[Booster OG] Failed to add OG role for member ${member.id}:`, error);
        return { action: "error", memberId: member.id };
      }

      try {
        await logChannel.send(buildBoosterOgGrantLog(member, config, timestamp));
        managedSet.add(member.id);
        logInfo(`Added OG to booster user ID: ${member.id}`);
        return { action: "granted", memberId: member.id };
      } catch (error) {
        console.error(`[Booster OG] Failed to write BOOSTER_OG_GRANTED for ${member.id}:`, error);

        try {
          await member.roles.remove(
            config.boosterOgRoleId,
            "Rollback because BOOSTER_OG_GRANTED log write failed"
          );
        } catch (rollbackError) {
          console.error(
            `[Booster OG] Failed to roll back OG role for member ${member.id}:`,
            rollbackError
          );
        }

        return { action: "error", memberId: member.id };
      }
    }

    if (boosting && hasOg && !managedByBot) {
      return { action: "none", memberId: member.id };
    }

    if (boosting && hasOg && managedByBot) {
      return { action: "none", memberId: member.id };
    }

    if (!boosting && hasOg && managedByBot) {
      const timestamp = new Date().toISOString();
      try {
        await member.roles.remove(
          config.boosterOgRoleId,
          `${BOOSTER_OG_CAMPAIGN_NAME}: ${BOOSTER_OG_REMOVED_REASON}`
        );
      } catch (error) {
        console.error(`[Booster OG] Failed to remove OG role for member ${member.id}:`, error);
        return { action: "error", memberId: member.id };
      }

      try {
        await logChannel.send(buildBoosterOgRemovedLog(member, config, timestamp));
        managedSet.delete(member.id);
        logInfo(`Removed OG from bot-managed non-booster user ID: ${member.id}`);
        return { action: "removed", memberId: member.id };
      } catch (error) {
        console.error(`[Booster OG] Failed to write BOOSTER_OG_REMOVED for ${member.id}:`, error);

        try {
          await member.roles.add(
            config.boosterOgRoleId,
            "Rollback because BOOSTER_OG_REMOVED log write failed"
          );
        } catch (rollbackError) {
          console.error(
            `[Booster OG] Failed to roll back OG removal for member ${member.id}:`,
            rollbackError
          );
        }

        return { action: "error", memberId: member.id };
      }
    }

    if (!boosting && hasOg && !managedByBot) {
      logInfo(`Skipped OG removal because user was not bot-managed: ${member.id}`);
      return { action: "skipped-not-managed", memberId: member.id };
    }

    if (!boosting && !hasOg && managedByBot) {
      const timestamp = new Date().toISOString();
      try {
        await logChannel.send(buildBoosterOgRemovedLog(member, config, timestamp));
        managedSet.delete(member.id);
        logInfo(`Cleared bot-managed OG slot for non-booster user ID: ${member.id}`);
        return { action: "removed", memberId: member.id };
      } catch (error) {
        console.error(`[Booster OG] Failed to write BOOSTER_OG_REMOVED for ${member.id}:`, error);
        return { action: "error", memberId: member.id };
      }
    }

    return { action: "none", memberId: member.id };
  } catch (error) {
    console.error(`[Booster OG] Failed to reconcile member ${member.id}:`, error);
    return { action: "error", memberId: member.id };
  }
}

export async function syncBoosterOgRolesForGuild(
  guild: Guild,
  config: BoosterOgConfig,
  managedSet: Set<string>
) {
  await ensureBoosterOgOperationalStatus(guild, config);
  const members = await guild.members.fetch();
  const summary: BoosterOgSyncSummary = {
    scanned: 0,
    granted: 0,
    removed: 0,
    skippedNotManaged: 0,
    skippedCap: 0,
    errors: 0,
  };

  for (const member of members.values()) {
    summary.scanned += 1;
    const result = await reconcileBoosterOgRoleForMember(member, config, managedSet);

    if (result.action === "granted") {
      summary.granted += 1;
      await delay(config.actionDelayMs);
      continue;
    }

    if (result.action === "removed") {
      summary.removed += 1;
      await delay(config.actionDelayMs);
      continue;
    }

    if (result.action === "skipped-not-managed") {
      summary.skippedNotManaged += 1;
      continue;
    }

    if (result.action === "skipped-cap") {
      summary.skippedCap += 1;
      continue;
    }

    if (result.action === "error") {
      summary.errors += 1;
    }
  }

  return summary;
}

export function startBoosterOgRoleWatcher(client: Client, config: BoosterOgConfig) {
  logInfo("Booster OG watcher enabled");

  let managedSet = new Set<string>();
  let watcherReady = false;
  let queue = Promise.resolve();
  let periodicTimer: NodeJS.Timeout | null = null;

  const queueTask = (label: string, task: () => Promise<void>) => {
    queue = queue
      .then(async () => {
        logDebug(config, `Queue start: ${label}`);
        await task();
        logDebug(config, `Queue done: ${label}`);
      })
      .catch((error) => {
        console.error(`[Booster OG] Task "${label}" failed:`, error);
      });

    return queue;
  };

  const runSync = async (guild: Guild, label: "startup" | "periodic") => {
    logInfo(`${label === "startup" ? "Startup" : "Periodic"} sync started`);
    try {
      const summary = await syncBoosterOgRolesForGuild(guild, config, managedSet);
      logInfo(
        `${label === "startup" ? "Startup" : "Periodic"} sync completed: scanned=${summary.scanned} granted=${summary.granted} removed=${summary.removed} skipped_not_managed=${summary.skippedNotManaged} skipped_cap=${summary.skippedCap} errors=${summary.errors}`
      );
    } catch (error) {
      console.error(`[Booster OG] ${label} sync failed:`, error);
    }
  };

  const initializeWatcher = async (readyClient: Client<true>) => {
    try {
      const guild = await readyClient.guilds.fetch(config.guildId);
      const { logChannel, boosterOgRole, serverBoosterRole, roleStatus, canUseLogChannel } =
        await ensureBoosterOgOperationalStatus(guild, config);

      logInfo(`Booster OG log channel loaded: ${logChannel.name} (${logChannel.id})`);
      logInfo(`Custom OG role loaded: ${boosterOgRole.name} (${boosterOgRole.id})`);
      if (serverBoosterRole) {
        logInfo(
          `Server Booster role loaded/readable: ${serverBoosterRole.name} (${serverBoosterRole.id})`
        );
      } else {
        logWarn(
          `Server Booster role ${config.serverBoosterRoleId} could not be fetched by name, but boost detection will still use member role IDs and premiumSince.`
        );
      }

      if (!roleStatus.canManageRoles) {
        logWarn("Permission warning: bot is missing Manage Roles.");
      }
      if (!roleStatus.roleIsBelowBot) {
        logWarn(
          `Permission warning: bot cannot manage OG role ${boosterOgRole.id}. Move the bot role above "${boosterOgRole.name}".`
        );
      }
      if (!canUseLogChannel) {
        logWarn(
          `Permission warning: bot cannot view/send/read history in OG log channel ${logChannel.id}.`
        );
      }

      managedSet = await loadBoosterOgManagedUsersFromLog(config);
      logInfo(`Loaded bot-managed OG users: ${managedSet.size}`);
      logInfo(`Bot-managed OG grant cap: ${config.maxActiveGrants}`);
      watcherReady = true;

      if (config.syncOnStart) {
        void queueTask("startup-sync", async () => {
          await runSync(guild, "startup");
        });
      } else {
        logInfo("Startup sync disabled by DISCORD_BOOSTER_OG_SYNC_ON_START=false");
      }

      if (config.syncIntervalMinutes > 0) {
        periodicTimer = setInterval(() => {
          void queueTask("periodic-sync", async () => {
            await runSync(guild, "periodic");
          });
        }, config.syncIntervalMinutes * 60_000);
        periodicTimer.unref?.();
      } else {
        logInfo("Periodic Booster OG sync disabled because DISCORD_BOOSTER_OG_SYNC_INTERVAL_MINUTES=0");
      }
    } catch (error) {
      console.error("[Booster OG] Failed to initialize watcher:", error);
    }
  };

  if (client.isReady()) {
    void initializeWatcher(client as Client<true>);
  } else {
    client.once(Events.ClientReady, (readyClient) => {
      void initializeWatcher(readyClient);
    });
  }

  client.on(Events.MessageCreate, (message: Message<boolean>) => {
    if (
      !watcherReady ||
      message.channelId !== config.logChannelId ||
      !message.inGuild() ||
      message.guildId !== config.guildId
    ) {
      return;
    }

    const parsed = parseBoosterOgLog(message.content);
    if (parsed) {
      applyBoosterOgLogToManagedSet(managedSet, parsed, config);
    }
  });

  client.on(Events.GuildMemberUpdate, (_oldMember, newMember) => {
    if (!watcherReady || newMember.guild.id !== config.guildId) {
      return;
    }

    void queueTask(`member-update:${newMember.id}`, async () => {
      await reconcileBoosterOgRoleForMember(newMember, config, managedSet);
    });
  });
}

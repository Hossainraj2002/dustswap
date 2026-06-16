import {
  ChannelType,
  PermissionFlagsBits,
  type Channel,
  type Client,
  type Guild,
  type Role,
  type TextChannel,
  type User,
} from "discord.js";

export const CAMPAIGN_NAME = "Early Contributor";
export const CLAIM_SUCCESS_HEADER = "CLAIM_SUCCESS";
export const DEFAULT_CONFIG = {
  guildId: "1494584551630962808",
  submitChannelId: "1495705489672241272",
  logChannelId: "1507650151337037844",
  roleId: "1495670418407948351",
  maxClaims: 5000,
};

const CLAIM_SUCCESS_REGEX =
  /^CLAIM_SUCCESS\r?\nCampaign: Early Contributor\r?\nDiscord ID: (?<discordUserId>\d+)\r?\nDiscord User: (?<discordUser>[^\r\n]+)\r?\nTweet ID: (?<tweetId>\d+)\r?\nTweet URL: (?<tweetUrl>https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+)\r?\nRole ID: (?<roleId>\d+)\r?\nClaim Number: (?<claimNumber>\d+)\/(?<maxClaims>\d+)\r?\nTime: (?<timestamp>[^\r\n]+)$/;

export type BotConfig = {
  botToken: string;
  guildId: string;
  submitChannelId: string;
  logChannelId: string;
  roleId: string;
  maxClaims: number;
};

export type NormalizedTweetLink = {
  tweetId: string;
  tweetUrl: string;
};

export type ParsedClaimSuccess = {
  discordUserId: string;
  discordUser: string;
  tweetId: string;
  tweetUrl: string;
  roleId: string;
  claimNumber: number;
  maxClaims: number;
  timestamp: string;
};

export type RuntimeState = {
  config: BotConfig;
  guild: Guild;
  submitChannel: TextChannel;
  logChannel: TextChannel;
  role: Role;
  claimedDiscordUserIds: Set<string>;
  claimedTweetIds: Set<string>;
  processedLogMessageIds: Set<string>;
  successfulClaimCount: number;
};

type LoadConfigOptions = {
  logPrefix?: string;
};

function warnWithPrefix(logPrefix: string | undefined, message: string) {
  if (logPrefix) {
    console.warn(`${logPrefix} ${message}`);
    return;
  }

  console.warn(message);
}

function readStringEnv(name: string, fallback: string | undefined, options: LoadConfigOptions) {
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

function readFirstStringEnv(
  names: string[],
  fallback: string | undefined,
  options: LoadConfigOptions
) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  if (fallback !== undefined) {
    warnWithPrefix(options.logPrefix, `${names.join("/")} not set. Using default ${fallback}.`);
    return fallback;
  }

  throw new Error(`${names.join(" or ")} is required.`);
}

function validateSnowflake(name: string, value: string) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a Discord snowflake.`);
  }
}

export function loadConfig(options: LoadConfigOptions = {}): BotConfig {
  const botToken = readFirstStringEnv(["DISCORD_BOT_TOKEN", "DISCORD_TOKEN"], undefined, options);
  const guildId = readFirstStringEnv(
    ["DISCORD_GUILD_ID", "GUILD_ID"],
    DEFAULT_CONFIG.guildId,
    options
  );
  const submitChannelId = readStringEnv(
    "DISCORD_EARLY_SUBMIT_CHANNEL_ID",
    DEFAULT_CONFIG.submitChannelId,
    options
  );
  const logChannelId = readStringEnv(
    "DISCORD_EARLY_LOG_CHANNEL_ID",
    DEFAULT_CONFIG.logChannelId,
    options
  );
  const roleId = readStringEnv("DISCORD_EARLY_ROLE_ID", DEFAULT_CONFIG.roleId, options);
  const maxClaimsRaw = process.env.DISCORD_EARLY_MAX_CLAIMS?.trim();

  validateSnowflake("DISCORD_GUILD_ID/GUILD_ID", guildId);
  validateSnowflake("DISCORD_EARLY_SUBMIT_CHANNEL_ID", submitChannelId);
  validateSnowflake("DISCORD_EARLY_LOG_CHANNEL_ID", logChannelId);
  validateSnowflake("DISCORD_EARLY_ROLE_ID", roleId);

  let maxClaims = DEFAULT_CONFIG.maxClaims;
  if (!maxClaimsRaw) {
    warnWithPrefix(
      options.logPrefix,
      `DISCORD_EARLY_MAX_CLAIMS not set. Using default ${DEFAULT_CONFIG.maxClaims}.`
    );
  } else {
    const parsed = Number.parseInt(maxClaimsRaw, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error("DISCORD_EARLY_MAX_CLAIMS must be a positive integer.");
    }
    maxClaims = parsed;
  }

  return {
    botToken,
    guildId,
    submitChannelId,
    logChannelId,
    roleId,
    maxClaims,
  };
}

export function normalizeTweetLink(content: string): NormalizedTweetLink | null {
  const matches = content.match(/https?:\/\/[^\s<>()]+/gi) ?? [];

  for (const match of matches) {
    const candidate = match.replace(/[),.!?]+$/g, "");

    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }

    const hostname = url.hostname.toLowerCase();
    if (
      hostname !== "x.com" &&
      hostname !== "twitter.com" &&
      hostname !== "www.x.com" &&
      hostname !== "www.twitter.com"
    ) {
      continue;
    }

    const parts = url.pathname
      .replace(/\/+$/g, "")
      .split("/")
      .filter(Boolean);

    if (parts.length !== 3 || parts[1]?.toLowerCase() !== "status") {
      continue;
    }

    const username = parts[0] ?? "";
    const tweetId = parts[2] ?? "";

    if (!/^[A-Za-z0-9_]{1,15}$/.test(username) || !/^\d+$/.test(tweetId)) {
      continue;
    }

    return {
      tweetId,
      tweetUrl: `https://x.com/${username}/status/${tweetId}`,
    };
  }

  return null;
}

export function formatDiscordUser(user: User) {
  if (user.discriminator && user.discriminator !== "0") {
    return `${user.username}#${user.discriminator}`;
  }

  return user.globalName ? `${user.username} (${user.globalName})` : user.username;
}

export function buildClaimSuccessLog(args: {
  discordUserId: string;
  discordUser: string;
  tweetId: string;
  tweetUrl: string;
  roleId: string;
  claimNumber: number;
  maxClaims: number;
  timestamp: string;
}) {
  return [
    CLAIM_SUCCESS_HEADER,
    `Campaign: ${CAMPAIGN_NAME}`,
    `Discord ID: ${args.discordUserId}`,
    `Discord User: ${args.discordUser}`,
    `Tweet ID: ${args.tweetId}`,
    `Tweet URL: ${args.tweetUrl}`,
    `Role ID: ${args.roleId}`,
    `Claim Number: ${args.claimNumber}/${args.maxClaims}`,
    `Time: ${args.timestamp}`,
  ].join("\n");
}

export function parseClaimSuccessLog(content: string): ParsedClaimSuccess | null {
  const match = content.match(CLAIM_SUCCESS_REGEX);
  if (!match?.groups) {
    return null;
  }

  const claimNumber = Number.parseInt(match.groups.claimNumber, 10);
  const maxClaims = Number.parseInt(match.groups.maxClaims, 10);

  if (!Number.isSafeInteger(claimNumber) || !Number.isSafeInteger(maxClaims)) {
    return null;
  }

  return {
    discordUserId: match.groups.discordUserId,
    discordUser: match.groups.discordUser,
    tweetId: match.groups.tweetId,
    tweetUrl: match.groups.tweetUrl,
    roleId: match.groups.roleId,
    claimNumber,
    maxClaims,
    timestamp: match.groups.timestamp,
  };
}

export function isUnknownMemberError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: number }).code === 10007
  );
}

export function applyClaimSuccessToState(
  state: RuntimeState,
  messageId: string,
  claim: ParsedClaimSuccess
) {
  if (state.processedLogMessageIds.has(messageId)) {
    return false;
  }

  state.processedLogMessageIds.add(messageId);
  state.claimedDiscordUserIds.add(claim.discordUserId);
  state.claimedTweetIds.add(claim.tweetId);
  state.successfulClaimCount += 1;
  return true;
}

export async function loadClaimHistory(state: RuntimeState) {
  let before: string | undefined;

  while (true) {
    const batch = await state.logChannel.messages.fetch({
      limit: 100,
      before,
    });

    if (batch.size === 0) {
      break;
    }

    for (const logMessage of batch.values()) {
      const parsed = parseClaimSuccessLog(logMessage.content);
      if (!parsed) {
        continue;
      }

      applyClaimSuccessToState(state, logMessage.id, parsed);
    }

    before = batch.last()?.id;
    if (!before) {
      break;
    }
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

export async function initializeState(
  client: Client<true>,
  config: BotConfig
): Promise<RuntimeState> {
  const guild = await client.guilds.fetch(config.guildId);
  const submitChannel = assertGuildTextChannel(
    await client.channels.fetch(config.submitChannelId),
    config.submitChannelId,
    guild.id,
    "Submit channel"
  );
  const logChannel = assertGuildTextChannel(
    await client.channels.fetch(config.logChannelId),
    config.logChannelId,
    guild.id,
    "Log channel"
  );
  const role = await guild.roles.fetch(config.roleId);

  if (!role) {
    throw new Error(`Role not found: ${config.roleId}`);
  }

  const state: RuntimeState = {
    config,
    guild,
    submitChannel,
    logChannel,
    role,
    claimedDiscordUserIds: new Set<string>(),
    claimedTweetIds: new Set<string>(),
    processedLogMessageIds: new Set<string>(),
    successfulClaimCount: 0,
  };

  await loadClaimHistory(state);

  return state;
}

export async function getRoleAssignmentStatus(guild: Guild, role: Role) {
  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  const canManageRoles = botMember.permissions.has(PermissionFlagsBits.ManageRoles);
  const roleIsBelowBot = role.position < botMember.roles.highest.position;

  return {
    botMember,
    canManageRoles,
    roleIsBelowBot,
    roleIsAssignable: canManageRoles && roleIsBelowBot,
  };
}

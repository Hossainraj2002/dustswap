import "dotenv/config";

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  type Guild,
  type Message,
  type Role,
  type TextChannel,
  type User,
} from "discord.js";

const CAMPAIGN_NAME = "Early Contributor";
const CLAIM_SUCCESS_HEADER = "CLAIM_SUCCESS";
const DEFAULT_CONFIG = {
  guildId: "1494584551630962808",
  submitChannelId: "1495705489672241272",
  logChannelId: "1507650151337037844",
  roleId: "1495670418407948351",
  maxClaims: 5000,
};

const CLAIM_SUCCESS_REGEX =
  /^CLAIM_SUCCESS\r?\nCampaign: Early Contributor\r?\nDiscord ID: (?<discordUserId>\d+)\r?\nDiscord User: (?<discordUser>[^\r\n]+)\r?\nTweet ID: (?<tweetId>\d+)\r?\nTweet URL: (?<tweetUrl>https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+)\r?\nRole ID: (?<roleId>\d+)\r?\nClaim Number: (?<claimNumber>\d+)\/(?<maxClaims>\d+)\r?\nTime: (?<timestamp>[^\r\n]+)$/;

type BotConfig = {
  botToken: string;
  guildId: string;
  submitChannelId: string;
  logChannelId: string;
  roleId: string;
  maxClaims: number;
};

type NormalizedTweetLink = {
  tweetId: string;
  tweetUrl: string;
};

type ParsedClaimSuccess = {
  discordUserId: string;
  discordUser: string;
  tweetId: string;
  tweetUrl: string;
  roleId: string;
  claimNumber: number;
  maxClaims: number;
  timestamp: string;
};

type RuntimeState = {
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

function logInfo(message: string) {
  console.log(`[Early Contributor Bot] ${message}`);
}

function logWarn(message: string) {
  console.warn(`[Early Contributor Bot] ${message}`);
}

function readStringEnv(name: string, fallback?: string) {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }

  if (fallback !== undefined) {
    logWarn(`${name} not set. Using default ${fallback}.`);
    return fallback;
  }

  throw new Error(`${name} is required.`);
}

function validateSnowflake(name: string, value: string) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a Discord snowflake.`);
  }
}

function loadConfig(): BotConfig {
  const botToken = readStringEnv("DISCORD_BOT_TOKEN");
  const guildId = readStringEnv("DISCORD_GUILD_ID", DEFAULT_CONFIG.guildId);
  const submitChannelId = readStringEnv(
    "DISCORD_EARLY_SUBMIT_CHANNEL_ID",
    DEFAULT_CONFIG.submitChannelId
  );
  const logChannelId = readStringEnv(
    "DISCORD_EARLY_LOG_CHANNEL_ID",
    DEFAULT_CONFIG.logChannelId
  );
  const roleId = readStringEnv("DISCORD_EARLY_ROLE_ID", DEFAULT_CONFIG.roleId);
  const maxClaimsRaw = process.env.DISCORD_EARLY_MAX_CLAIMS?.trim();

  validateSnowflake("DISCORD_GUILD_ID", guildId);
  validateSnowflake("DISCORD_EARLY_SUBMIT_CHANNEL_ID", submitChannelId);
  validateSnowflake("DISCORD_EARLY_LOG_CHANNEL_ID", logChannelId);
  validateSnowflake("DISCORD_EARLY_ROLE_ID", roleId);

  let maxClaims = DEFAULT_CONFIG.maxClaims;
  if (!maxClaimsRaw) {
    logWarn(
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

function normalizeTweetLink(content: string): NormalizedTweetLink | null {
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

function formatDiscordUser(user: User) {
  if (user.discriminator && user.discriminator !== "0") {
    return `${user.username}#${user.discriminator}`;
  }

  return user.globalName ? `${user.username} (${user.globalName})` : user.username;
}

function buildClaimSuccessLog(args: {
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

function parseClaimSuccessLog(content: string): ParsedClaimSuccess | null {
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

function isUnknownMemberError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: number }).code === 10007
  );
}

function applyClaimSuccessToState(
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

async function loadClaimHistory(state: RuntimeState) {
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

async function initializeState(client: Client<true>, config: BotConfig): Promise<RuntimeState> {
  const guild = await client.guilds.fetch(config.guildId);
  const submitChannelRaw = await client.channels.fetch(config.submitChannelId);
  const logChannelRaw = await client.channels.fetch(config.logChannelId);
  const role = await guild.roles.fetch(config.roleId);

  if (!submitChannelRaw) {
    throw new Error(`Submit channel not found: ${config.submitChannelId}`);
  }
  if (submitChannelRaw.type !== ChannelType.GuildText) {
    throw new Error(
      `Submit channel must be a guild text channel: ${config.submitChannelId}`
    );
  }
  if (submitChannelRaw.guildId !== guild.id) {
    throw new Error(
      `Submit channel ${config.submitChannelId} does not belong to guild ${guild.id}.`
    );
  }

  if (!logChannelRaw) {
    throw new Error(`Log channel not found: ${config.logChannelId}`);
  }
  if (logChannelRaw.type !== ChannelType.GuildText) {
    throw new Error(`Log channel must be a guild text channel: ${config.logChannelId}`);
  }
  if (logChannelRaw.guildId !== guild.id) {
    throw new Error(`Log channel ${config.logChannelId} does not belong to guild ${guild.id}.`);
  }

  if (!role) {
    throw new Error(`Role not found: ${config.roleId}`);
  }

  const submitChannel = submitChannelRaw as TextChannel;
  const logChannel = logChannelRaw as TextChannel;

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

  const botMember = await guild.members.fetchMe();
  const canManageRoles = botMember.permissions.has(PermissionFlagsBits.ManageRoles);
  const roleIsAssignable = role.position < botMember.roles.highest.position;

  logInfo(`Bot logged in as ${client.user.username}`);
  logInfo(`Guild ID loaded: ${guild.id}`);
  logInfo(`Submit channel loaded: ${submitChannel.name} (${submitChannel.id})`);
  logInfo(`Log channel loaded: ${logChannel.name} (${logChannel.id})`);
  logInfo(`Role loaded: ${role.name} (${role.id})`);
  logInfo(
    `Existing successful claims loaded: ${state.successfulClaimCount}/${config.maxClaims}`
  );

  if (!canManageRoles) {
    logWarn("Bot is missing the Manage Roles permission.");
  }
  if (!roleIsAssignable) {
    logWarn(
      `Bot cannot assign role ${role.id}. Move the bot role above "${role.name}" in Discord.`
    );
  }

  return state;
}

async function safeReply(message: Message, content: string) {
  try {
    await message.reply({
      content,
      allowedMentions: { repliedUser: false },
    });
  } catch (error) {
    console.error(
      `[Early Contributor Bot] Failed to reply to message ${message.id}:`,
      error
    );
  }
}

async function processClaimMessage(state: RuntimeState, message: Message) {
  try {
    const normalizedTweet = normalizeTweetLink(message.content);
    if (!normalizedTweet) {
      await safeReply(
        message,
        "⚠️ Please submit a valid X/Twitter post link. Example: https://x.com/username/status/123456789"
      );
      return;
    }

    if (state.claimedDiscordUserIds.has(message.author.id)) {
      await safeReply(
        message,
        "⚠️ You already claimed the Early Contributor role."
      );
      return;
    }

    if (state.claimedTweetIds.has(normalizedTweet.tweetId)) {
      await safeReply(message, "⚠️ This tweet link was already used for a claim.");
      return;
    }

    if (state.successfulClaimCount >= state.config.maxClaims) {
      await safeReply(
        message,
        `⚠️ Early Contributor claim is full. All ${state.config.maxClaims.toLocaleString()} spots have been claimed.`
      );
      return;
    }

    const botMember = state.guild.members.me ?? (await state.guild.members.fetchMe());
    const roleIsAssignable =
      botMember.permissions.has(PermissionFlagsBits.ManageRoles) &&
      state.role.position < botMember.roles.highest.position;

    if (!roleIsAssignable) {
      logWarn(
        `Role assignment blocked. Bot cannot assign role ${state.role.id} in guild ${state.guild.id}.`
      );
      await safeReply(
        message,
        "⚠️ I couldn't assign the Early Contributor role. Please contact a moderator."
      );
      return;
    }

    const member = await state.guild.members.fetch(message.author.id).catch((error: unknown) => {
      if (isUnknownMemberError(error)) {
        return null;
      }
      throw error;
    });

    if (!member) {
      await safeReply(
        message,
        "⚠️ You must still be a member of this Discord server to claim the role."
      );
      return;
    }

    const claimNumber = state.successfulClaimCount + 1;
    const timestamp = new Date().toISOString();

    try {
      await member.roles.add(
        state.role.id,
        `${CAMPAIGN_NAME} claim #${claimNumber}/${state.config.maxClaims}`
      );
    } catch (error) {
      console.error(
        `[Early Contributor Bot] Failed to assign role ${state.role.id} to user ${message.author.id}:`,
        error
      );
      await safeReply(
        message,
        "⚠️ I couldn't assign the Early Contributor role. Please contact a moderator."
      );
      return;
    }

    const claimLog = buildClaimSuccessLog({
      discordUserId: message.author.id,
      discordUser: formatDiscordUser(message.author),
      tweetId: normalizedTweet.tweetId,
      tweetUrl: normalizedTweet.tweetUrl,
      roleId: state.role.id,
      claimNumber,
      maxClaims: state.config.maxClaims,
      timestamp,
    });

    try {
      const logMessage = await state.logChannel.send(claimLog);
      applyClaimSuccessToState(state, logMessage.id, {
        discordUserId: message.author.id,
        discordUser: formatDiscordUser(message.author),
        tweetId: normalizedTweet.tweetId,
        tweetUrl: normalizedTweet.tweetUrl,
        roleId: state.role.id,
        claimNumber,
        maxClaims: state.config.maxClaims,
        timestamp,
      });
    } catch (error) {
      console.error(
        `[Early Contributor Bot] Failed to write claim log for user ${message.author.id}:`,
        error
      );

      try {
        await member.roles.remove(
          state.role.id,
          "Rollback because claim log write failed"
        );
      } catch (rollbackError) {
        console.error(
          `[Early Contributor Bot] Failed to roll back role ${state.role.id} for user ${message.author.id}:`,
          rollbackError
        );
      }

      await safeReply(
        message,
        "⚠️ Your claim could not be finalized right now. Please try again later."
      );
      return;
    }

    await safeReply(
      message,
      `✅ Verified. Early Contributor role added. You are claim #${claimNumber}/${state.config.maxClaims}.`
    );
  } catch (error) {
    console.error(
      `[Early Contributor Bot] Failed to process message ${message.id}:`,
      error
    );
    await safeReply(
      message,
      "⚠️ Something went wrong while processing your claim. Please try again later."
    );
  }
}

async function main() {
  const config = loadConfig();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  let runtimeState: RuntimeState | null = null;
  let claimQueue = Promise.resolve();

  client.once(Events.ClientReady, async (readyClient: Client<true>) => {
    try {
      runtimeState = await initializeState(readyClient, config);
    } catch (error) {
      console.error("[Early Contributor Bot] Startup failed:", error);
      await readyClient.destroy();
      process.exit(1);
    }
  });

  client.on(Events.MessageCreate, (message: Message<boolean>) => {
    if (!runtimeState || !message.inGuild() || message.guildId !== runtimeState.guild.id) {
      return;
    }

    if (message.channelId === runtimeState.config.logChannelId) {
      const parsed = parseClaimSuccessLog(message.content);
      if (parsed) {
        applyClaimSuccessToState(runtimeState, message.id, parsed);
      }
      return;
    }

    if (message.author.bot || message.channelId !== runtimeState.config.submitChannelId) {
      return;
    }

    claimQueue = claimQueue
      .then(async () => {
        if (!runtimeState) {
          return;
        }
        await processClaimMessage(runtimeState, message);
      })
      .catch((error) => {
        console.error("[Early Contributor Bot] Claim queue error:", error);
      });
  });

  client.on(Events.Error, (error: Error) => {
    console.error("[Early Contributor Bot] Client error:", error);
  });

  await client.login(config.botToken);
}

void main().catch((error) => {
  console.error(
    `[Early Contributor Bot] ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});

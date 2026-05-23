import "dotenv/config";

import { createServer } from "node:http";
import {
  Client,
  Events,
  GatewayIntentBits,
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
  parseClaimSuccessLog,
  type RuntimeState,
} from "./earlyContributorBotCore";

const DEBUG_LOGGING_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.EARLY_CONTRIBUTOR_BOT_DEBUG?.trim() || ""
);

function logInfo(message: string) {
  console.log(`[Early Contributor Bot] ${message}`);
}

function logWarn(message: string) {
  console.warn(`[Early Contributor Bot] ${message}`);
}

function logDebug(message: string) {
  if (DEBUG_LOGGING_ENABLED) {
    console.log(`[Early Contributor Bot][debug] ${message}`);
  }
}

async function safeReply(message: Message, content: string) {
  try {
    await message.reply({
      content,
      allowedMentions: { repliedUser: false },
    });
  } catch (error) {
    console.error(`[Early Contributor Bot] Failed to reply to message ${message.id}:`, error);

    try {
      if ("send" in message.channel) {
        await message.channel.send(content);
      }
    } catch (fallbackError) {
      console.error(
        `[Early Contributor Bot] Fallback send also failed for message ${message.id}:`,
        fallbackError
      );
    }
  }
}

async function processClaimMessage(state: RuntimeState, message: Message) {
  try {
    logDebug(
      `Processing message ${message.id} from ${message.author.id} in channel ${message.channelId}`
    );

    const normalizedTweet = normalizeTweetLink(message.content);
    if (!normalizedTweet) {
      logDebug(`Message ${message.id} did not include a valid X/Twitter status URL.`);
      await safeReply(
        message,
        "⚠️ Please submit a valid X/Twitter post link. Example: https://x.com/username/status/123456789"
      );
      return;
    }

    if (state.claimedDiscordUserIds.has(message.author.id)) {
      logDebug(`User ${message.author.id} already claimed.`);
      await safeReply(
        message,
        "⚠️ You already claimed the Early Contributor role."
      );
      return;
    }

    if (state.claimedTweetIds.has(normalizedTweet.tweetId)) {
      logDebug(`Tweet ${normalizedTweet.tweetId} was already claimed.`);
      await safeReply(message, "⚠️ This tweet link was already used for a claim.");
      return;
    }

    if (state.successfulClaimCount >= state.config.maxClaims) {
      logDebug(`Claim cap reached at ${state.successfulClaimCount}/${state.config.maxClaims}.`);
      await safeReply(
        message,
        `⚠️ Early Contributor claim is full. All ${state.config.maxClaims.toLocaleString()} spots have been claimed.`
      );
      return;
    }

    const roleStatus = await getRoleAssignmentStatus(state.guild, state.role);
    if (!roleStatus.roleIsAssignable) {
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
      logDebug(`User ${message.author.id} is not a current guild member.`);
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
      logInfo(
        `Claim success #${claimNumber}/${state.config.maxClaims}: user=${message.author.id} tweet=${normalizedTweet.tweetId}`
      );
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

function startHealthServer() {
  const port = Number.parseInt(process.env.PORT ?? "", 10);
  if (!Number.isSafeInteger(port) || port <= 0) {
    logDebug("No PORT provided. Health server not started.");
    return;
  }

  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "early-contributor-bot" }));
  });

  server.listen(port, () => {
    logInfo(`Health server listening on port ${port}`);
  });
}

async function main() {
  logInfo("Bootstrapping bot process...");
  const config = loadConfig({ logPrefix: "[Early Contributor Bot]" });
  logInfo(
    `Config loaded: guild=${config.guildId}, submit=${config.submitChannelId}, log=${config.logChannelId}, role=${config.roleId}, maxClaims=${config.maxClaims}`
  );

  startHealthServer();

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
      logInfo("Discord client connected. Loading guild, channels, role, and claim history...");
      runtimeState = await initializeState(readyClient, config);
      const roleStatus = await getRoleAssignmentStatus(runtimeState.guild, runtimeState.role);
      logInfo(`Bot logged in as ${readyClient.user.username}`);
      logInfo(`Guild ID loaded: ${runtimeState.guild.id}`);
      logInfo(
        `Submit channel loaded: ${runtimeState.submitChannel.name} (${runtimeState.submitChannel.id})`
      );
      logInfo(
        `Log channel loaded: ${runtimeState.logChannel.name} (${runtimeState.logChannel.id})`
      );
      logInfo(`Role loaded: ${runtimeState.role.name} (${runtimeState.role.id})`);
      logInfo(
        `Existing successful claims loaded: ${runtimeState.successfulClaimCount}/${config.maxClaims}`
      );

      if (!roleStatus.canManageRoles) {
        logWarn("Bot is missing the Manage Roles permission.");
      }
      if (!roleStatus.roleIsBelowBot) {
        logWarn(
          `Bot cannot assign role ${runtimeState.role.id}. Move the bot role above "${runtimeState.role.name}" in Discord.`
        );
      }
    } catch (error) {
      console.error("[Early Contributor Bot] Startup failed:", error);
      await readyClient.destroy();
      process.exit(1);
    }
  });

  client.on(Events.MessageCreate, (message: Message<boolean>) => {
    if (!runtimeState || !message.inGuild() || message.guildId !== runtimeState.guild.id) {
      if (DEBUG_LOGGING_ENABLED && message.inGuild()) {
        logDebug(
          `Ignoring message ${message.id}: initialized=${Boolean(runtimeState)} guild=${message.guildId}`
        );
      }
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
      if (DEBUG_LOGGING_ENABLED && !message.author.bot) {
        logDebug(`Ignoring message ${message.id} from channel ${message.channelId}.`);
      }
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

  client.on(Events.Warn, (warning: string) => {
    console.warn("[Early Contributor Bot] Client warning:", warning);
  });

  await client.login(config.botToken);
}

process.on("unhandledRejection", (reason) => {
  console.error("[Early Contributor Bot] Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[Early Contributor Bot] Uncaught exception:", error);
});

void main().catch((error) => {
  console.error(
    `[Early Contributor Bot] ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});

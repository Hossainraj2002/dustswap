import {
  AttachmentBuilder,
  ChannelType,
  Events,
  PermissionFlagsBits,
  type AnyThreadChannel,
  type Channel,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type PartialMessage,
  type TextBasedChannel,
  type User,
} from "discord.js";
import { formatDiscordUser, isUnknownMemberError } from "./earlyContributorBotCore";

const DEFAULT_ALLOWED_DOMAINS = ["x.com", "twitter.com", "dustswap.wtf"] as const;
const DUSTSWAP_ROOT_DOMAIN = "dustswap.wtf";
const VIOLATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIRST_TIMEOUT_MS = 60 * 60 * 1000;
const SECOND_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const WARNING_DELETE_MS = 10 * 1000;
const WARNING_MESSAGE =
  "Your message was removed because only official Dustswap links and X links are allowed in this server. Repeated violations will result in timeout or ban.";
const BAN_REASON = "Repeated blocked/scam link violations in Dustswap Discord";
const LOG_HEADER = "ANTI_SCAM_LINK_FILTER";

export type AntiScamFilterConfig = {
  guildId: string;
  modLogChannelId: string;
  trustedRoleIds: Set<string>;
  allowedDomains: Set<string>;
  channelWarningEnabled: boolean;
  dmWarningEnabled: boolean;
};

type LoadAntiScamConfigOptions = {
  logPrefix?: string;
};

type MessageEventKind = "messageCreate" | "messageUpdate";

type DmWarningStatus = "succeeded" | "failed" | "disabled" | "skipped";

type DeleteStatus = {
  success: boolean;
  label: string;
};

type LogRecord = {
  status: "DELETED" | "STAFF EXEMPT - EXTERNAL LINK NOT DELETED" | "PERMISSION WARNING";
  eventKind: MessageEventKind | "startup" | "threadCreate" | "threadUpdate";
  userTag?: string;
  userId?: string;
  channelName?: string;
  channelId?: string;
  messageLink?: string;
  blockedDomains?: string[];
  originalContent?: string;
  scannedText?: string;
  actionTaken: string;
  violationCount?: number;
  dmWarningStatus?: DmWarningStatus;
  timestamp: string;
};

function logInfo(message: string) {
  console.log(`[Anti-Scam Filter] ${message}`);
}

function logWarn(message: string) {
  console.warn(`[Anti-Scam Filter] ${message}`);
}

function warnWithPrefix(logPrefix: string | undefined, message: string) {
  if (logPrefix) {
    console.warn(`${logPrefix} ${message}`);
    return;
  }

  console.warn(message);
}

function readFirstStringEnv(
  names: string[],
  fallback: string | undefined,
  options: LoadAntiScamConfigOptions
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

function validateSnowflake(name: string, value: string) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a Discord snowflake.`);
  }
}

function parseSnowflakeSet(raw: string | undefined) {
  const values = new Set<string>();
  for (const item of raw?.split(",") ?? []) {
    const value = item.trim();
    if (!value) {
      continue;
    }
    validateSnowflake("TRUSTED_ROLE_IDS", value);
    values.add(value);
  }
  return values;
}

function parseAllowedDomains(raw: string | undefined) {
  const values = raw
    ?.split(",")
    .map((value) => normalizeHostname(value))
    .filter(Boolean);

  return new Set(values && values.length > 0 ? values : DEFAULT_ALLOWED_DOMAINS);
}

export function loadAntiScamFilterConfig(
  options: LoadAntiScamConfigOptions = {}
): AntiScamFilterConfig {
  const guildId = readFirstStringEnv(["GUILD_ID", "DISCORD_GUILD_ID"], undefined, options);
  const modLogChannelId = readFirstStringEnv(["MOD_LOG_CHANNEL_ID"], undefined, options);

  validateSnowflake("GUILD_ID/DISCORD_GUILD_ID", guildId);
  validateSnowflake("MOD_LOG_CHANNEL_ID", modLogChannelId);

  return {
    guildId,
    modLogChannelId,
    trustedRoleIds: parseSnowflakeSet(process.env.TRUSTED_ROLE_IDS),
    allowedDomains: parseAllowedDomains(process.env.ALLOWED_DOMAINS),
    channelWarningEnabled: parseBooleanEnv("CHANNEL_WARNING_ENABLED", true),
    dmWarningEnabled: parseBooleanEnv("DM_WARNING_ENABLED", true),
  };
}

export function normalizeHostname(hostname: string) {
  let normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("www.")) {
    normalized = normalized.slice(4);
  }
  return normalized;
}

export function isAllowedHostname(hostname: string, allowedDomains: Set<string>) {
  const normalized = normalizeHostname(hostname);

  if (allowedDomains.has(normalized)) {
    return true;
  }

  // Only the official Dustswap root allows real subdomains. This prevents
  // lookalikes such as dustswap.wtf.evil.com or dustswap-wtf.com.
  return (
    allowedDomains.has(DUSTSWAP_ROOT_DOMAIN) &&
    normalized.endsWith(`.${DUSTSWAP_ROOT_DOMAIN}`)
  );
}

function trimUrlCandidate(candidate: string) {
  return candidate
    .trim()
    .replace(/^[<([{]+/g, "")
    .replace(/[>\])}.,!?;:'"]+$/g, "");
}

export function extractHostnamesFromText(text: string) {
  const hostnames = new Set<string>();
  const patterns = [
    /\bhttps?:\/\/[^\s<>"']+/gi,
    /\bwww\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:[/?#][^\s<>"']*)?/gi,
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{2,5})?(?:[/?#][^\s<>"']*)?/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = trimUrlCandidate(match[0] ?? "");
      if (!candidate) {
        continue;
      }

      try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
        const hostname = normalizeHostname(url.hostname);
        if (hostname) {
          hostnames.add(hostname);
        }
      } catch {
        continue;
      }
    }
  }

  return [...hostnames];
}

export function findBlockedDomainsInText(text: string, allowedDomains: Set<string>) {
  return extractHostnamesFromText(text).filter(
    (hostname) => !isAllowedHostname(hostname, allowedDomains)
  );
}

function collectMessageText(message: Message<boolean>) {
  const parts: string[] = [];

  if (message.content) {
    parts.push(message.content);
  }

  for (const embed of message.embeds) {
    if (embed.url) {
      parts.push(embed.url);
    }
    if (embed.title) {
      parts.push(embed.title);
    }
    if (embed.description) {
      parts.push(embed.description);
    }
    if (embed.author?.name) {
      parts.push(embed.author.name);
    }
    if (embed.author?.url) {
      parts.push(embed.author.url);
    }
    if (embed.footer?.text) {
      parts.push(embed.footer.text);
    }
    for (const field of embed.fields) {
      parts.push(field.name, field.value);
    }
  }

  for (const attachment of message.attachments.values()) {
    parts.push(attachment.name);
    if (attachment.title) {
      parts.push(attachment.title);
    }
    if (attachment.description) {
      parts.push(attachment.description);
    }
  }

  return parts.join("\n");
}

export function findBlockedDomainsInMessage(
  message: Message<boolean>,
  config: Pick<AntiScamFilterConfig, "allowedDomains">
) {
  return [...new Set(findBlockedDomainsInText(collectMessageText(message), config.allowedDomains))];
}

function getChannelName(channel: TextBasedChannel | Channel | null) {
  if (!channel) {
    return "unknown";
  }

  if ("name" in channel && typeof channel.name === "string") {
    return channel.name;
  }

  return "unknown";
}

function isConfiguredGuildMessage(
  message: Message<boolean>,
  config: AntiScamFilterConfig
): message is Message<true> {
  return message.inGuild() && message.guildId === config.guildId;
}

function memberHasTrustedRole(member: GuildMember | null, trustedRoleIds: Set<string>) {
  if (!member || trustedRoleIds.size === 0) {
    return false;
  }

  return member.roles.cache.some((role) => trustedRoleIds.has(role.id));
}

async function fetchMessageIfNeeded(message: Message<boolean> | PartialMessage) {
  if (message.partial) {
    try {
      return await message.fetch();
    } catch (error) {
      console.error("[Anti-Scam Filter] Failed to fetch partial message:", error);
      return null;
    }
  }

  return message;
}

async function fetchMemberForMessage(message: Message<true>) {
  if (message.member) {
    return message.member;
  }

  try {
    return await message.guild.members.fetch(message.author.id);
  } catch (error) {
    if (isUnknownMemberError(error)) {
      return null;
    }
    console.error(`[Anti-Scam Filter] Failed to fetch member ${message.author.id}:`, error);
    return null;
  }
}

async function deleteBlockedMessage(message: Message<true>): Promise<DeleteStatus> {
  try {
    await message.delete();
    return { success: true, label: "message deleted" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[Anti-Scam Filter] Failed to delete message ${message.id}:`, error);
    return { success: false, label: `message delete failed: ${detail}` };
  }
}

async function sendChannelWarning(message: Message<true>, config: AntiScamFilterConfig) {
  if (!config.channelWarningEnabled) {
    return "channel warning disabled";
  }

  try {
    const warning = await message.channel.send({
      content: WARNING_MESSAGE,
      allowedMentions: { parse: [] },
    });

    const timer = setTimeout(() => {
      void warning.delete().catch((error: unknown) => {
        console.error(`[Anti-Scam Filter] Failed to auto-delete warning ${warning.id}:`, error);
      });
    }, WARNING_DELETE_MS);
    timer.unref?.();

    return "channel warning sent";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[Anti-Scam Filter] Failed to send channel warning for ${message.id}:`, error);
    return `channel warning failed: ${detail}`;
  }
}

async function sendDmWarning(user: User, config: AntiScamFilterConfig): Promise<DmWarningStatus> {
  if (!config.dmWarningEnabled) {
    return "disabled";
  }

  try {
    await user.send(WARNING_MESSAGE);
    return "succeeded";
  } catch (error) {
    console.error(`[Anti-Scam Filter] Failed to DM user ${user.id}:`, error);
    return "failed";
  }
}

function pruneOldViolations(timestamps: number[], now: number) {
  const cutoff = now - VIOLATION_WINDOW_MS;
  return timestamps.filter((timestamp) => timestamp >= cutoff);
}

function recordViolation(
  violationTimestampsByUserId: Map<string, number[]>,
  userId: string,
  now: number
) {
  const timestamps = pruneOldViolations(violationTimestampsByUserId.get(userId) ?? [], now);
  timestamps.push(now);
  violationTimestampsByUserId.set(userId, timestamps);
  return timestamps.length;
}

async function applyViolationAction(
  message: Message<true>,
  member: GuildMember | null,
  violationCount: number
) {
  if (violationCount <= 1) {
    if (!member) {
      return "1st violation: timeout 1h failed because member was unavailable";
    }

    try {
      await member.timeout(FIRST_TIMEOUT_MS, "Blocked/scam link violation in Dustswap Discord");
      return "1st violation: timeout 1h applied";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[Anti-Scam Filter] Failed to timeout ${message.author.id} for 1h:`, error);
      return `1st violation: timeout 1h failed: ${detail}`;
    }
  }

  if (violationCount === 2) {
    if (!member) {
      return "2nd violation: timeout 12h failed because member was unavailable";
    }

    try {
      await member.timeout(SECOND_TIMEOUT_MS, "Repeated blocked/scam link violation in Dustswap Discord");
      return "2nd violation: timeout 12h applied";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[Anti-Scam Filter] Failed to timeout ${message.author.id} for 12h:`, error);
      return `2nd violation: timeout 12h failed: ${detail}`;
    }
  }

  try {
    await message.guild.members.ban(message.author.id, { reason: BAN_REASON });
    return "3rd violation: user banned";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[Anti-Scam Filter] Failed to ban ${message.author.id}:`, error);
    return `3rd violation: ban failed: ${detail}`;
  }
}

function messageLink(message: Message<true>) {
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

function truncateForDiscord(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 20)}\n[truncated in log]`;
}

function buildLogContent(record: LogRecord) {
  const lines = [
    LOG_HEADER,
    `Status: ${record.status}`,
    `Event: ${record.eventKind}`,
    `User: ${record.userTag ?? "n/a"}`,
    `User ID: ${record.userId ?? "n/a"}`,
    `Channel: ${record.channelName ?? "n/a"}`,
    `Channel ID: ${record.channelId ?? "n/a"}`,
    `Message Link: ${record.messageLink ?? "n/a"}`,
    `Blocked Domains: ${record.blockedDomains?.join(", ") || "n/a"}`,
    `Action Taken: ${record.actionTaken}`,
    `Violation Count: ${record.violationCount ?? "n/a"}`,
    `DM Warning: ${record.dmWarningStatus ?? "n/a"}`,
    `Time: ${record.timestamp}`,
  ];

  if (record.originalContent !== undefined || record.scannedText !== undefined) {
    lines.push("Original Message Content: attached as full text file");
  }

  return truncateForDiscord(lines.join("\n"), 1800);
}

function buildLogAttachment(record: LogRecord) {
  const body = [
    `Status: ${record.status}`,
    `Event: ${record.eventKind}`,
    `User: ${record.userTag ?? "n/a"}`,
    `User ID: ${record.userId ?? "n/a"}`,
    `Channel: ${record.channelName ?? "n/a"}`,
    `Channel ID: ${record.channelId ?? "n/a"}`,
    `Message Link: ${record.messageLink ?? "n/a"}`,
    `Blocked Domains: ${record.blockedDomains?.join(", ") || "n/a"}`,
    `Action Taken: ${record.actionTaken}`,
    `Violation Count: ${record.violationCount ?? "n/a"}`,
    `DM Warning: ${record.dmWarningStatus ?? "n/a"}`,
    `Time: ${record.timestamp}`,
    "",
    "Full Original Message Content:",
    record.originalContent || "[empty message content]",
    "",
    "Full Scanned Text:",
    record.scannedText || "[empty scanned text]",
  ].join("\n");

  return new AttachmentBuilder(Buffer.from(body, "utf8"), {
    name: `anti-scam-log-${record.timestamp.replace(/[:.]/g, "-")}.txt`,
  });
}

function isGuildTextBasedChannel(
  channel: Channel | null,
  guildId: string
): channel is GuildTextBasedChannel {
  return Boolean(channel?.isTextBased() && "guildId" in channel && channel.guildId === guildId);
}

async function fetchModLogChannel(client: Client, config: AntiScamFilterConfig) {
  const channel = await client.channels.fetch(config.modLogChannelId).catch((error: unknown) => {
    console.error(`[Anti-Scam Filter] Failed to fetch mod log channel ${config.modLogChannelId}:`, error);
    return null;
  });

  if (!isGuildTextBasedChannel(channel, config.guildId)) {
    logWarn(`MOD_LOG_CHANNEL_ID ${config.modLogChannelId} is not a guild text-based channel.`);
    return null;
  }

  return channel;
}

async function sendModLog(
  client: Client,
  config: AntiScamFilterConfig,
  record: LogRecord
) {
  const modLogChannel = await fetchModLogChannel(client, config);
  if (!modLogChannel) {
    return;
  }

  try {
    const files =
      record.originalContent !== undefined || record.scannedText !== undefined
        ? [buildLogAttachment(record)]
        : [];

    await modLogChannel.send({
      content: buildLogContent(record),
      files,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error("[Anti-Scam Filter] Failed to send mod log:", error);
  }
}

function parseViolationLog(content: string) {
  if (!content.startsWith(LOG_HEADER)) {
    return null;
  }

  if (!/^Status:\s+DELETED$/m.test(content)) {
    return null;
  }

  const userId = content.match(/^User ID:\s+(\d+)$/m)?.[1];
  const timestampRaw = content.match(/^Time:\s+(.+)$/m)?.[1];
  if (!userId || !timestampRaw) {
    return null;
  }

  const timestamp = Date.parse(timestampRaw);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return { userId, timestamp };
}

async function loadRecentViolationsFromModLog(
  client: Client,
  config: AntiScamFilterConfig,
  violationTimestampsByUserId: Map<string, number[]>
) {
  const modLogChannel = await fetchModLogChannel(client, config);
  if (!modLogChannel) {
    return;
  }

  const cutoff = Date.now() - VIOLATION_WINDOW_MS;
  let before: string | undefined;
  let loaded = 0;

  while ("messages" in modLogChannel) {
    const batch = await modLogChannel.messages
      .fetch({ limit: 100, before })
      .catch((error: unknown) => {
        console.error("[Anti-Scam Filter] Failed to read mod log history:", error);
        return null;
      });

    if (!batch || batch.size === 0) {
      break;
    }

    for (const logMessage of batch.values()) {
      if (logMessage.createdTimestamp < cutoff) {
        before = undefined;
        break;
      }

      const parsed = parseViolationLog(logMessage.content);
      if (!parsed || parsed.timestamp < cutoff) {
        continue;
      }

      const timestamps = violationTimestampsByUserId.get(parsed.userId) ?? [];
      timestamps.push(parsed.timestamp);
      violationTimestampsByUserId.set(parsed.userId, timestamps);
      loaded += 1;
    }

    if (!before && batch.last()?.createdTimestamp && batch.last()!.createdTimestamp < cutoff) {
      break;
    }

    before = batch.last()?.id;
    if (!before) {
      break;
    }
  }

  for (const [userId, timestamps] of violationTimestampsByUserId) {
    violationTimestampsByUserId.set(userId, pruneOldViolations(timestamps, Date.now()));
  }

  logInfo(`Loaded ${loaded} recent violation log entries from the last 24 hours.`);
}

function permissionMissing(
  permissions: ReturnType<GuildMember["permissionsIn"]>,
  permission: bigint
) {
  return !permissions.has(permission);
}

function isScannableChannel(channel: GuildBasedChannel) {
  return [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type);
}

function missingChannelPermissions(
  channel: GuildBasedChannel,
  botMember: GuildMember,
  config: AntiScamFilterConfig
) {
  const permissions = botMember.permissionsIn(channel);
  const missing: string[] = [];

  if (permissionMissing(permissions, PermissionFlagsBits.ViewChannel)) {
    missing.push("View Channel");
  }
  if (permissionMissing(permissions, PermissionFlagsBits.ReadMessageHistory)) {
    missing.push("Read Message History");
  }
  if (permissionMissing(permissions, PermissionFlagsBits.ManageMessages)) {
    missing.push("Manage Messages");
  }

  if (config.channelWarningEnabled) {
    const sendPermission = channel.isThread()
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages;
    if (permissionMissing(permissions, sendPermission)) {
      missing.push(channel.isThread() ? "Send Messages In Threads" : "Send Messages");
    }
  }

  return missing;
}

async function warnProtectionGap(
  client: Client,
  config: AntiScamFilterConfig,
  message: string
) {
  logWarn(message);
  await sendModLog(client, config, {
    status: "PERMISSION WARNING",
    eventKind: "startup",
    actionTaken: message,
    timestamp: new Date().toISOString(),
  });
}

async function scanChannelPermissions(
  client: Client,
  config: AntiScamFilterConfig,
  guild: Guild,
  channel: GuildBasedChannel
) {
  if (!isScannableChannel(channel)) {
    return;
  }

  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  const missing = missingChannelPermissions(channel, botMember, config);
  for (const permission of missing) {
    await warnProtectionGap(
      client,
      config,
      `Anti-scam filter cannot fully protect #${getChannelName(channel)} (${channel.id}) because missing permission: ${permission}`
    );
  }
}

async function scanGuildPermissions(client: Client, config: AntiScamFilterConfig, guild: Guild) {
  const botMember = guild.members.me ?? (await guild.members.fetchMe());

  if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await warnProtectionGap(
      client,
      config,
      "Anti-scam filter cannot fully protect the guild because missing permission: Moderate Members"
    );
  }

  if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
    await warnProtectionGap(
      client,
      config,
      "Anti-scam filter cannot fully protect the guild because missing permission: Ban Members"
    );
  }

  const channels = await guild.channels.fetch();
  for (const channel of channels.values()) {
    if (channel) {
      await scanChannelPermissions(client, config, guild, channel);
    }
  }

  const activeThreads = await guild.channels.fetchActiveThreads().catch((error: unknown) => {
    console.error("[Anti-Scam Filter] Failed to fetch active threads:", error);
    return null;
  });

  for (const thread of activeThreads?.threads.values() ?? []) {
    await scanChannelPermissions(client, config, guild, thread);
  }
}

async function tryJoinThread(thread: AnyThreadChannel) {
  if (!thread.joinable || thread.joined) {
    return;
  }

  try {
    await thread.join();
    logInfo(`Joined thread for anti-scam access: ${thread.name} (${thread.id})`);
  } catch (error) {
    console.error(`[Anti-Scam Filter] Failed to join thread ${thread.id}:`, error);
  }
}

export function startAntiScamLinkFilter(client: Client, config: AntiScamFilterConfig) {
  logInfo("Global anti-scam link filter enabled");
  logInfo(`Allowed domains: ${[...config.allowedDomains].join(", ")}`);
  logInfo(`Trusted staff role IDs: ${config.trustedRoleIds.size || "none configured"}`);

  const violationTimestampsByUserId = new Map<string, number[]>();
  const handledViolationMessageIds = new Set<string>();
  let queue = Promise.resolve();

  const queueTask = (label: string, task: () => Promise<void>) => {
    queue = queue
      .then(async () => {
        await task();
      })
      .catch((error) => {
        console.error(`[Anti-Scam Filter] Task "${label}" failed:`, error);
      });

    return queue;
  };

  const handleMessage = async (
    rawMessage: Message<boolean> | PartialMessage,
    eventKind: MessageEventKind
  ) => {
    const fetched = await fetchMessageIfNeeded(rawMessage);
    if (!fetched || !isConfiguredGuildMessage(fetched, config)) {
      return;
    }

    if (fetched.author.id === client.user?.id) {
      return;
    }

    const blockedDomains = findBlockedDomainsInMessage(fetched, config);
    if (blockedDomains.length === 0) {
      return;
    }

    const member = await fetchMemberForMessage(fetched);
    const scannedText = collectMessageText(fetched);
    const timestamp = new Date().toISOString();
    const baseLog = {
      eventKind,
      userTag: formatDiscordUser(fetched.author),
      userId: fetched.author.id,
      channelName: getChannelName(fetched.channel),
      channelId: fetched.channelId,
      messageLink: messageLink(fetched),
      blockedDomains,
      originalContent: fetched.content,
      scannedText,
      timestamp,
    } satisfies Partial<LogRecord>;

    if (memberHasTrustedRole(member, config.trustedRoleIds)) {
      await sendModLog(client, config, {
        ...baseLog,
        status: "STAFF EXEMPT - EXTERNAL LINK NOT DELETED",
        actionTaken: "STAFF EXEMPT - EXTERNAL LINK NOT DELETED",
        dmWarningStatus: "skipped",
      } as LogRecord);
      return;
    }

    if (handledViolationMessageIds.has(fetched.id)) {
      return;
    }
    handledViolationMessageIds.add(fetched.id);

    const violationCount = recordViolation(
      violationTimestampsByUserId,
      fetched.author.id,
      Date.now()
    );

    const deleteStatus = await deleteBlockedMessage(fetched);
    const channelWarningStatus = await sendChannelWarning(fetched, config);
    const dmWarningStatus = await sendDmWarning(fetched.author, config);
    const moderationStatus = await applyViolationAction(fetched, member, violationCount);

    await sendModLog(client, config, {
      ...baseLog,
      status: "DELETED",
      actionTaken: `${deleteStatus.label}; ${channelWarningStatus}; ${moderationStatus}`,
      violationCount,
      dmWarningStatus,
    } as LogRecord);
  };

  client.once(Events.ClientReady, (readyClient) => {
    void queueTask("startup", async () => {
      const guild = await readyClient.guilds.fetch(config.guildId);
      await loadRecentViolationsFromModLog(readyClient, config, violationTimestampsByUserId);
      await scanGuildPermissions(readyClient, config, guild);
      logInfo(`Startup permission scan completed for guild ${guild.id}.`);
    });
  });

  client.on(Events.GuildCreate, (guild) => {
    if (guild.id !== config.guildId) {
      return;
    }

    void queueTask(`guildCreate:${guild.id}`, async () => {
      await scanGuildPermissions(client, config, guild);
    });
  });

  client.on(Events.ThreadCreate, (thread) => {
    if (thread.guildId !== config.guildId) {
      return;
    }

    void queueTask(`threadCreate:${thread.id}`, async () => {
      await tryJoinThread(thread);
      await scanChannelPermissions(client, config, thread.guild, thread);
    });
  });

  client.on(Events.ThreadUpdate, (_oldThread, newThread) => {
    if (newThread.guildId !== config.guildId) {
      return;
    }

    void queueTask(`threadUpdate:${newThread.id}`, async () => {
      await tryJoinThread(newThread);
      await scanChannelPermissions(client, config, newThread.guild, newThread);
    });
  });

  client.on(Events.MessageCreate, (message) => {
    void queueTask(`messageCreate:${message.id}`, async () => {
      await handleMessage(message, "messageCreate");
    });
  });

  client.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
    void queueTask(`messageUpdate:${newMessage.id}`, async () => {
      await handleMessage(newMessage, "messageUpdate");
    });
  });
}

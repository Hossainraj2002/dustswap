import {
  AttachmentBuilder,
  ChannelType,
  Events,
  PermissionFlagsBits,
  WebhookType,
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

const DEFAULT_ALLOWED_DOMAINS = [
  // Official Dustswap (real subdomains such as app.dustswap.wtf are allowed too)
  "dustswap.wtf",
  // X / Twitter ecosystem. Subdomains (mobile.x.com), media (pbs.twimg.com,
  // video.twimg.com), the t.co link shortener, and the embed-fixer domains
  // people routinely paste for X posts are all covered.
  "x.com",
  "twitter.com",
  "t.co",
  "twimg.com",
  "fxtwitter.com",
  "vxtwitter.com",
  "fixupx.com",
  // Discord-native media: attachment CDN + the built-in GIF pickers. Note we
  // deliberately do NOT allow discord.com / discord.gg so invite links stay
  // blocked per server policy.
  "discordapp.com",
  "discordapp.net",
  "tenor.com",
  "giphy.com",
  // Block explorers. basescan.org is in DustSwap's own official-links doc, and
  // members share explorer tx links constantly in a Base/BSC community; leaving
  // these blocked would wrongly time users out. Read-only, safe to allow.
  "basescan.org",
  "bscscan.com",
  "etherscan.io",
] as const;
const VIOLATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIRST_TIMEOUT_MS = 60 * 60 * 1000;
const SECOND_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const THIRD_TIMEOUT_MS = 24 * 60 * 60 * 1000;
// Untrusted webhooks are removed only after this many blocked posts in the
// window, so a single off-allowlist link from a legit (un-allowlisted) webhook
// does not nuke it, while a leaked/abused webhook that keeps spamming is killed.
const WEBHOOK_AUTO_DELETE_THRESHOLD = 2;
const WARNING_DELETE_MS = 10 * 1000;
const WARNING_MESSAGE =
  "Your message was removed because only official Dustswap links and X links are allowed in this server. Repeated violations will result in timeout or ban.";
const BAN_REASON = "Repeated blocked/scam link violations in Dustswap Discord";
const LOG_HEADER = "ANTI_SCAM_LINK_FILTER";
const COMMON_FILE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "csv",
  "doc",
  "docx",
  "gif",
  "heic",
  "jpeg",
  "jpg",
  "json",
  "mov",
  "mp3",
  "mp4",
  "pdf",
  "png",
  "svg",
  "txt",
  "webm",
  "webp",
  "xls",
  "xlsx",
  "zip",
]);

export type AntiScamFilterConfig = {
  guildId: string;
  modLogChannelId: string;
  trustedRoleIds: Set<string>;
  allowedDomains: Set<string>;
  channelWarningEnabled: boolean;
  dmWarningEnabled: boolean;
  // Application/user IDs of bots that are fully trusted (your ticket bot, mod
  // bots, your own bots). Trusted integrations are never scanned or touched.
  trustedBotIds: Set<string>;
  // Webhook IDs that are fully trusted (e.g. your CI/status webhook). Trusted
  // webhooks are never scanned or touched.
  trustedWebhookIds: Set<string>;
  // Scan messages from *untrusted incoming webhooks* (the leaked-webhook-URL
  // attack vector) and delete any that carry a blocked link. On by default —
  // this is the main defense against a scammer abusing a webhook. Webhooks are
  // never banned (you cannot ban a webhook); see deleteUntrustedWebhooks.
  moderateWebhooks: boolean;
  // When an untrusted incoming webhook posts a blocked link, also delete the
  // webhook itself (requires Manage Webhooks), not just the message. On by
  // default: a non-allowlisted webhook posting scam links is almost certainly
  // leaked/malicious, so removing it stops the whole spam run at the source.
  deleteUntrustedWebhooks: boolean;
  // Scan messages from *untrusted bots* (bots not on trustedBotIds) and delete
  // blocked-link messages. Off by default because a bot can only be added by an
  // admin; enable if you want defense against a socially-engineered rogue bot.
  // Untrusted bots are deleted-only, never timed out or banned.
  moderateUntrustedBots: boolean;
  // Scan Discord's auto-generated link-preview embeds. Off by default: for human
  // messages these are unfurled from links already present in the content, so
  // scanning them re-flags the target page's own links (e.g. a quoted tweet).
  scanEmbeds: boolean;
  // Scan attachment file names / titles / descriptions. Off by default: a
  // Discord-hosted upload is not a clickable link, and file names like clip.mkv
  // were being misread as blocked domains.
  scanAttachments: boolean;
  // Permanently ban on the 3rd violation. Off by default; when off the 3rd
  // violation applies a 24h timeout instead of an irreversible ban.
  autoBanEnabled: boolean;
  // Treat members with Administrator / Manage Server / Moderate Members / Manage
  // Messages as exempt (like trusted staff), so moderators are never auto-punished.
  exemptElevatedMembers: boolean;
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
  status:
    | "DELETED"
    | "STAFF EXEMPT - EXTERNAL LINK NOT DELETED"
    | "PERMISSION WARNING"
    | "UNTRUSTED WEBHOOK - DELETED"
    | "UNTRUSTED BOT - DELETED";
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

function parseSnowflakeSet(raw: string | undefined, label = "TRUSTED_ROLE_IDS") {
  const values = new Set<string>();
  for (const item of raw?.split(",") ?? []) {
    const value = item.trim();
    if (!value) {
      continue;
    }
    validateSnowflake(label, value);
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
    trustedBotIds: parseSnowflakeSet(process.env.TRUSTED_BOT_IDS, "TRUSTED_BOT_IDS"),
    trustedWebhookIds: parseSnowflakeSet(process.env.TRUSTED_WEBHOOK_IDS, "TRUSTED_WEBHOOK_IDS"),
    moderateWebhooks: parseBooleanEnv("ANTI_SCAM_MODERATE_WEBHOOKS", true),
    deleteUntrustedWebhooks: parseBooleanEnv("ANTI_SCAM_DELETE_UNTRUSTED_WEBHOOKS", true),
    moderateUntrustedBots: parseBooleanEnv("ANTI_SCAM_MODERATE_UNTRUSTED_BOTS", false),
    scanEmbeds: parseBooleanEnv("ANTI_SCAM_SCAN_EMBEDS", false),
    scanAttachments: parseBooleanEnv("ANTI_SCAM_SCAN_ATTACHMENTS", false),
    autoBanEnabled: parseBooleanEnv("ANTI_SCAM_AUTO_BAN", false),
    exemptElevatedMembers: parseBooleanEnv("ANTI_SCAM_EXEMPT_ELEVATED", true),
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

  // Allow real subdomains of any allowed root (app.dustswap.wtf, mobile.x.com,
  // pbs.twimg.com, media.tenor.com, cdn.discordapp.com ...). Matching on a
  // leading "." keeps lookalikes such as dustswap.wtf.evil.com blocked: they
  // end in ".evil.com" and therefore match no allowed root.
  for (const root of allowedDomains) {
    if (normalized.endsWith(`.${root}`)) {
      return true;
    }
  }

  return false;
}

function trimUrlCandidate(candidate: string) {
  return candidate
    .trim()
    .replace(/^[<([{]+/g, "")
    .replace(/[>\])}.,!?;:'"]+$/g, "");
}

function looksLikeBareFileName(candidate: string, url: URL, hasProtocol: boolean) {
  if (hasProtocol || /[/?#]/.test(candidate)) {
    return false;
  }

  const lastPart = url.hostname.split(".").pop()?.toLowerCase();
  return Boolean(lastPart && COMMON_FILE_EXTENSIONS.has(lastPart));
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
        const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate);
        const url = new URL(hasProtocol ? candidate : `https://${candidate}`);
        if (looksLikeBareFileName(candidate, url, hasProtocol)) {
          continue;
        }

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

type MessageScanOptions = {
  scanEmbeds?: boolean;
  scanAttachments?: boolean;
};

function collectMessageText(message: Message<boolean>, options: MessageScanOptions = {}) {
  const parts: string[] = [];

  if (message.content) {
    parts.push(message.content);
  }

  // Discord unfurls link-preview embeds from URLs already in the content, so for
  // ordinary human messages the embeds contain the *target* page's own links
  // (e.g. links inside a quoted tweet). Scanning them punishes people for simply
  // posting an allowed X link, so it is opt-in via ANTI_SCAM_SCAN_EMBEDS.
  if (options.scanEmbeds) {
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
  }

  // Attachment file names are not clickable links, and a Discord-hosted upload
  // cannot be a phishing domain. Scanning them mislabels ordinary files
  // (clip.mkv, photo.tiff, audio.flac ...) as blocked domains, so it is opt-in
  // via ANTI_SCAM_SCAN_ATTACHMENTS.
  if (options.scanAttachments) {
    for (const attachment of message.attachments.values()) {
      parts.push(attachment.name);
      if (attachment.title) {
        parts.push(attachment.title);
      }
      if (attachment.description) {
        parts.push(attachment.description);
      }
    }
  }

  return parts.join("\n");
}

export function findBlockedDomainsInMessage(
  message: Message<boolean>,
  config: Pick<AntiScamFilterConfig, "allowedDomains" | "scanEmbeds" | "scanAttachments">
) {
  const text = collectMessageText(message, {
    scanEmbeds: config.scanEmbeds,
    scanAttachments: config.scanAttachments,
  });
  return [...new Set(findBlockedDomainsInText(text, config.allowedDomains))];
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

function memberIsElevated(member: GuildMember | null, config: AntiScamFilterConfig) {
  if (!member || !config.exemptElevatedMembers) {
    return false;
  }

  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
    member.permissions.has(PermissionFlagsBits.ManageMessages)
  );
}

type AuthorClass =
  | "self"
  | "trusted-integration"
  | "untrusted-webhook"
  | "untrusted-bot"
  | "human";

// A real, deletable incoming webhook carries a webhookId that differs from any
// applicationId. Bot interaction/slash-command responses set webhookId ===
// applicationId, so this reliably separates "someone POSTed through a webhook
// URL" (the leaked-URL attack) from an ordinary bot reply.
function isRealIncomingWebhookMessage(message: Message<true>) {
  return Boolean(message.webhookId) && message.webhookId !== message.applicationId;
}

function isTrustedIntegration(message: Message<true>, config: AntiScamFilterConfig) {
  if (message.webhookId && config.trustedWebhookIds.has(message.webhookId)) {
    return true;
  }
  if (config.trustedBotIds.has(message.author.id)) {
    return true;
  }
  if (message.applicationId && config.trustedBotIds.has(message.applicationId)) {
    return true;
  }
  return false;
}

function classifyAuthor(
  message: Message<true>,
  client: Client,
  config: AntiScamFilterConfig
): AuthorClass {
  if (message.author.id === client.user?.id) {
    return "self";
  }
  if (isTrustedIntegration(message, config)) {
    return "trusted-integration";
  }
  if (isRealIncomingWebhookMessage(message)) {
    return "untrusted-webhook";
  }
  if (message.author.bot) {
    return "untrusted-bot";
  }
  return "human";
}

// Integration (bot/webhook) messages can carry attacker-controlled rich embeds,
// so unlike human messages we always scan the embed contents here.
function findBlockedDomainsForIntegration(message: Message<true>, config: AntiScamFilterConfig) {
  const text = collectMessageText(message, { scanEmbeds: true, scanAttachments: false });
  return [...new Set(findBlockedDomainsInText(text, config.allowedDomains))];
}

async function deleteWebhookForMessage(message: Message<true>, reason: string) {
  try {
    const webhook = await message.fetchWebhook();
    if (webhook.type !== WebhookType.Incoming) {
      return "webhook not deleted: not a deletable incoming webhook";
    }
    await webhook.delete(reason);
    return "malicious webhook deleted";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[Anti-Scam Filter] Failed to delete webhook for message ${message.id}:`, error);
    return `webhook delete failed: ${detail}`;
  }
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
  violationCount: number,
  config: AntiScamFilterConfig
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

  if (config.autoBanEnabled) {
    try {
      await message.guild.members.ban(message.author.id, { reason: BAN_REASON });
      return "3rd violation: user banned";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[Anti-Scam Filter] Failed to ban ${message.author.id}:`, error);
      return `3rd violation: ban failed: ${detail}`;
    }
  }

  // Auto-ban disabled (default): apply a long timeout instead of an
  // irreversible ban. Re-enable permanent bans with ANTI_SCAM_AUTO_BAN=true.
  if (!member) {
    return "3rd violation: 24h timeout failed because member was unavailable (auto-ban disabled)";
  }

  try {
    await member.timeout(THIRD_TIMEOUT_MS, "Repeated blocked/scam link violation in Dustswap Discord");
    return "3rd violation: timeout 24h applied (auto-ban disabled)";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[Anti-Scam Filter] Failed to timeout ${message.author.id} for 24h:`, error);
    return `3rd violation: 24h timeout failed: ${detail}`;
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

  if (
    config.deleteUntrustedWebhooks &&
    !botMember.permissions.has(PermissionFlagsBits.ManageWebhooks)
  ) {
    await warnProtectionGap(
      client,
      config,
      "Anti-scam filter cannot remove malicious webhooks because missing permission: Manage Webhooks"
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
  logInfo(
    `Trusted integrations: ${config.trustedBotIds.size} bot ID(s), ${config.trustedWebhookIds.size} webhook ID(s)`
  );
  logInfo(
    `Integration policy: untrusted webhooks=${
      config.moderateWebhooks
        ? `scan+delete${config.deleteUntrustedWebhooks ? " (auto-remove webhook)" : ""}`
        : "off"
    }, untrusted bots=${config.moderateUntrustedBots ? "scan+delete" : "off"}, auto-ban=${
      config.autoBanEnabled ? "on" : "off (24h timeout)"
    }`
  );

  const violationTimestampsByUserId = new Map<string, number[]>();
  const webhookBlockedTimestampsById = new Map<string, number[]>();
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

  // Untrusted bots/webhooks: remove the scam message (and, for webhooks, the
  // webhook itself) but never treat them as member violations, time out, or ban.
  const handleIntegrationMessage = async (
    message: Message<true>,
    authorClass: "untrusted-webhook" | "untrusted-bot",
    eventKind: MessageEventKind
  ) => {
    const isWebhook = authorClass === "untrusted-webhook";

    // Untrusted webhooks are moderated by default (leaked-URL threat); untrusted
    // bots only when ANTI_SCAM_MODERATE_UNTRUSTED_BOTS is enabled.
    if (isWebhook ? !config.moderateWebhooks : !config.moderateUntrustedBots) {
      return;
    }

    const blockedDomains = findBlockedDomainsForIntegration(message, config);
    if (blockedDomains.length === 0) {
      return;
    }

    if (handledViolationMessageIds.has(message.id)) {
      return;
    }
    handledViolationMessageIds.add(message.id);

    const deleteStatus = await deleteBlockedMessage(message);
    const actions = [deleteStatus.label];

    if (isWebhook) {
      if (!config.deleteUntrustedWebhooks) {
        actions.push("webhook left in place (ANTI_SCAM_DELETE_UNTRUSTED_WEBHOOKS disabled)");
      } else {
        const offenseCount = recordViolation(
          webhookBlockedTimestampsById,
          message.webhookId!,
          Date.now()
        );
        if (offenseCount >= WEBHOOK_AUTO_DELETE_THRESHOLD) {
          actions.push(
            await deleteWebhookForMessage(
              message,
              "Untrusted webhook repeatedly posted blocked/scam links in Dustswap Discord"
            )
          );
        } else {
          actions.push(
            `webhook flagged ${offenseCount}/${WEBHOOK_AUTO_DELETE_THRESHOLD}; message removed, webhook kept for now`
          );
        }
      }
    } else {
      actions.push("untrusted bot: message removed, no timeout or ban");
    }

    await sendModLog(client, config, {
      status: isWebhook ? "UNTRUSTED WEBHOOK - DELETED" : "UNTRUSTED BOT - DELETED",
      eventKind,
      userTag: formatDiscordUser(message.author),
      userId: message.webhookId ?? message.author.id,
      channelName: getChannelName(message.channel),
      channelId: message.channelId,
      messageLink: messageLink(message),
      blockedDomains,
      originalContent: message.content,
      scannedText: collectMessageText(message, { scanEmbeds: true, scanAttachments: false }),
      actionTaken: actions.join("; "),
      dmWarningStatus: "skipped",
      timestamp: new Date().toISOString(),
    });
  };

  const handleMessage = async (
    rawMessage: Message<boolean> | PartialMessage,
    eventKind: MessageEventKind
  ) => {
    const fetched = await fetchMessageIfNeeded(rawMessage);
    if (!fetched || !isConfiguredGuildMessage(fetched, config)) {
      return;
    }

    const authorClass = classifyAuthor(fetched, client, config);

    // The filter's own messages and explicitly trusted integrations (your
    // ticket bot, mod bots, CI/status webhooks) are never scanned or touched.
    if (authorClass === "self" || authorClass === "trusted-integration") {
      return;
    }

    // Untrusted webhooks and bots are handled separately: their scam messages
    // (and, for webhooks, the webhook itself) are removed, but they are never
    // counted as member violations, timed out, or banned.
    if (authorClass === "untrusted-webhook" || authorClass === "untrusted-bot") {
      await handleIntegrationMessage(fetched, authorClass, eventKind);
      return;
    }

    // ----- Human members -----
    const blockedDomains = findBlockedDomainsInMessage(fetched, config);
    if (blockedDomains.length === 0) {
      return;
    }

    const member = await fetchMemberForMessage(fetched);
    const scannedText = collectMessageText(fetched, {
      scanEmbeds: config.scanEmbeds,
      scanAttachments: config.scanAttachments,
    });
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

    if (memberHasTrustedRole(member, config.trustedRoleIds) || memberIsElevated(member, config)) {
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

    const deleteStatus = await deleteBlockedMessage(fetched);
    const channelWarningStatus = await sendChannelWarning(fetched, config);

    const violationCount = recordViolation(
      violationTimestampsByUserId,
      fetched.author.id,
      Date.now()
    );

    const dmWarningStatus = await sendDmWarning(fetched.author, config);
    const moderationStatus = await applyViolationAction(fetched, member, violationCount, config);

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

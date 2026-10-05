// SYNCED from apps/memefun/src/core/tweet.ts by scripts/sync-shared.ts. Edit the original, then run pnpm sync-shared.
import type { Address } from "./types";

/** Public X post data. IDs are strings: X snowflakes exceed JavaScript's safe integer range. */
export interface TweetAuthor {
  id: string;
  handle: string;
  name: string;
  avatarUrl?: string;
}

export interface TweetPhoto {
  id: string;
  url: string;
  width?: number;
  height?: number;
}

export interface TweetSource {
  postId: string;
  url: string;
  text: string;
  author: TweetAuthor;
  photoId?: string;
}

export interface TweetImport extends Omit<TweetSource, "photoId"> {
  photos: TweetPhoto[];
  suggestedName: string;
  suggestedTicker: string;
  /** True only when the server has the live author-fee signing configuration. */
  authorFeesSupported: boolean;
}

export interface TweetAttribution {
  postId: string;
  authorXUserId: string;
  authorShareBps: number;
  /** Epoch milliseconds when treasury may also withdraw the unpaid author balance. */
  treasuryUnlockAt: number;
  treasuryUnlocked?: boolean;
  /** Legacy timestamp alias. This is not a verification or author-claim deadline. */
  verifyBy?: number;
  authorWallet?: Address;
  /** Historical treasury withdrawal; later author fees may accrue and remain claimable. */
  reclaimed?: boolean;
  source?: TweetSource;
}

export interface TweetLaunchAttestation {
  source: TweetImport;
  launcher: Address;
  salt: `0x${string}`;
  tweet: { postId: string; authorXUserId: string; authorShareBps: number };
  deadline: string;
  signature: `0x${string}`;
  chainId: number;
  factory: Address;
  reserveDays: 180;
}

export interface AuthorVerification {
  coin: Address;
  authorXUserId: string;
  wallet: Address;
  deadline: string;
  signature: `0x${string}`;
  chainId: number;
  feeVault: Address;
}

export const TWEET_LAUNCH_TYPES = {
  TweetLaunch: [
    { name: "launcher", type: "address" }, { name: "salt", type: "bytes32" },
    { name: "postId", type: "uint256" }, { name: "authorXUserId", type: "uint256" },
    { name: "authorShareBps", type: "uint16" }, { name: "deadline", type: "uint256" },
  ],
} as const;

export const AUTHOR_VERIFICATION_TYPES = {
  AuthorVerification: [
    { name: "coin", type: "address" }, { name: "authorXUserId", type: "uint256" },
    { name: "wallet", type: "address" }, { name: "deadline", type: "uint256" },
  ],
} as const;

export const AUTHOR_SHARE_MIN_BPS = 2_000;
export const AUTHOR_SHARE_MAX_BPS = 10_000;
export const AUTHOR_SHARE_DEFAULT_BPS = 5_000;
export const AUTHOR_RESERVE_DAYS = 180;
const X_HOSTS = new Set(["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
const MEDIA_HOSTS = new Set(["pbs.twimg.com", "abs.twimg.com"]);
const UINT64_MAX = 18_446_744_073_709_551_615n;
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function validXId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= UINT64_MAX;
}

export function validateAuthorShareBps(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= AUTHOR_SHARE_MIN_BPS && value <= AUTHOR_SHARE_MAX_BPS;
}

/** Only extract an ID. The server calls a fixed GetXAPI endpoint, never the submitted URL. */
export function parseTweetUrl(input: string): { postId: string; url: string } {
  if (typeof input !== "string" || input.length > 2_048) throw new Error("Paste a public X post link.");
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new Error("Paste a public X post link.");
  }
  if (parsed.protocol !== "https:" || !X_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.port) {
    throw new Error("Use an https link from x.com or twitter.com.");
  }
  const match = /^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/(?:web\/)?status)\/([1-9]\d{0,19})(?:\/(?:photo|video)\/[1-4])?\/?$/.exec(parsed.pathname);
  const postId = match?.[1];
  if (!postId || !validXId(postId)) throw new Error("Use a link to one X post, including its status ID.");
  return { postId, url: `https://x.com/i/status/${postId}` };
}

/** Own-media URLs only. External links and quoted-post images are never imported. */
export function safeTweetMediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !MEDIA_HOSTS.has(url.hostname) || url.username || url.password || url.port) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(HIDDEN, "").slice(0, max).trim() : "";
}

/** Suggestions need no AI key or credits. They remain editable before launch. */
export function suggestTweetIdentity(text: string, postId: string): { suggestedName: string; suggestedTicker: string } {
  const normalized = cleanText(text, 5_000).replace(/https?:\/\/\S+|@[A-Za-z0-9_]+/g, " ");
  const cashtag = /(?:^|\s)\$([A-Za-z][A-Za-z0-9]{1,9})(?=\s|[.,!?;:]|$)/.exec(normalized)?.[1];
  const hashtag = /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_]{1,31})/u.exec(normalized)?.[1];
  const stop = new Set(["the", "a", "an", "and", "or", "but", "to", "of", "for", "in", "on", "is", "are", "this", "that", "it", "its", "with", "at", "be", "i", "we", "you", "my", "our", "your"]);
  const words = normalized.replace(/[$#]/g, "").match(/[\p{L}\p{N}]+/gu)?.filter(word => !stop.has(word.toLowerCase())) ?? [];
  const base = hashtag?.replace(/_/g, " ") || words.slice(0, 3).join(" ") || `Post ${postId.slice(-6)}`;
  let suggestedName = base.slice(0, 32).trim();
  // Do not split a UTF-16 surrogate pair at the form's 32-character limit.
  if (/[\uD800-\uDBFF]$/.test(suggestedName)) suggestedName = suggestedName.slice(0, -1);
  const tickerBase = (cashtag || hashtag || words.slice(0, 2).join("")).normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10);
  const suggestedTicker = tickerBase.length >= 2 ? tickerBase : `X${postId.slice(-6)}`;
  return { suggestedName, suggestedTicker };
}

/** Treat the provider response as untrusted, including its ID, author and URLs. */
export function normalizeTweetResponse(payload: unknown, requestedId: string): TweetImport {
  const envelope = record(payload);
  const post = record(envelope.data);
  if (!validXId(requestedId) || post.id !== requestedId || (envelope.status !== undefined && envelope.status !== "success")) {
    throw new Error("The post could not be verified. Try another public post.");
  }
  const author = record(post.author);
  if (!validXId(author.id) || author.protected === true || post.isUnavailable === true || post.isDeleted === true) {
    throw new Error("Use an available public X post with a verified author ID.");
  }
  const handle = cleanText(author.userName ?? author.username, 16);
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error("The post author could not be verified.");
  const text = cleanText(post.text ?? post.full_text, 5_000);
  const entities = record(post.extended_entities ?? post.extendedEntities);
  const basicEntities = record(post.entities);
  const rawMedia = Array.isArray(post.media) && post.media.length ? post.media : Array.isArray(entities.media) ? entities.media : Array.isArray(basicEntities.media) ? basicEntities.media : [];
  const photos: TweetPhoto[] = [];
  const seen = new Set<string>();
  for (const [index, item] of rawMedia.slice(0, 16).entries()) {
    const media = record(item);
    const mediaUrl = [media.media_url_https, media.media_url, media.mediaUrl, media.url, media.preview_image_url, media.thumbnail_url].map(safeTweetMediaUrl).find(Boolean);
    if (!mediaUrl || seen.has(mediaUrl)) continue;
    seen.add(mediaUrl);
    const size = record(record(media.sizes).large ?? media.original_info);
    const width = size.w ?? size.width ?? media.width;
    const height = size.h ?? size.height ?? media.height;
    const id = typeof media.id_str === "string" ? media.id_str : typeof media.id === "string" ? media.id : `photo-${index + 1}`;
    photos.push({ id: id.slice(0, 100), url: mediaUrl,
      ...(typeof width === "number" && Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(typeof height === "number" && Number.isFinite(height) && height > 0 ? { height } : {}),
    });
    if (photos.length === 4) break;
  }
  const avatarUrl = safeTweetMediaUrl(author.profilePicture ?? author.profile_image_url_https);
  return {
    postId: requestedId,
    url: `https://x.com/${handle}/status/${requestedId}`,
    text,
    author: { id: author.id, handle, name: cleanText(author.name, 100) || handle, ...(avatarUrl ? { avatarUrl } : {}) },
    photos,
    ...suggestTweetIdentity(text, requestedId),
    authorFeesSupported: false,
  };
}

import type { Address, Hash } from "@/core/types";
import { AUTHOR_RESERVE_DAYS, validateAuthorShareBps, type TweetImport, type TweetSource } from "@/core/tweet";
import { normalizeCoinImage } from "./image";
export { AUTHOR_SHARE_DEFAULT_BPS, AUTHOR_SHARE_MIN_BPS, parseTweetUrl } from "@/core/tweet";
export type { TweetImport, TweetSource } from "@/core/tweet";

export const AUTHOR_TREASURY_UNLOCK_DAYS = AUTHOR_RESERVE_DAYS;

/** Older API responses named this treasury unlock time verifyBy; it is not an author deadline. */
export function authorTreasuryUnlockAt(tweet: { treasuryUnlockAt?: number; verifyBy?: number }): number {
  const value = tweet.treasuryUnlockAt ?? tweet.verifyBy;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Infinity;
}

export interface TweetDraft {
  source: TweetSource;
  authorShareBps: number;
  photoId?: string;
  imported?: TweetImport;
}

export interface AuthorSession {
  authorId: string;
  handle: string;
  wallet?: Address;
  simulated: boolean;
}

export interface AuthorReward {
  coin: Address;
  poolId: Hash;
  quoteSymbol: string;
  amountQuote: number;
  amountUsd: number;
  currency?: Address;
  amountRaw?: string;
}

const escapeSvg = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!));

/** A code-generated text image; no image model, external request or AI credits. */
export function tweetTextImage(source: Pick<TweetSource, "text" | "author">): string {
  const words = source.text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  for (const word of words) {
    if (!lines.length || (lines[lines.length - 1]!.length + word.length > 22)) lines.push(word.slice(0, 22));
    else lines[lines.length - 1] += ` ${word}`;
    if (lines.length === 6) break;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="64" fill="#0052ff"/><text x="64" y="102" fill="#b8ceff" font-family="Arial,sans-serif" font-size="25">@${escapeSvg(source.author.handle)}</text><text fill="white" font-family="Arial,sans-serif" font-size="32" font-weight="700">${lines.map((line, i) => `<tspan x="64" y="${168 + i * 43}">${escapeSvg(line)}</tspan>`).join("")}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function validAuthorShare(value: number) {
  return validateAuthorShareBps(value);
}

export async function prepareTweetImage(source: TweetSource, photoUrl?: string): Promise<string> {
  if (photoUrl) {
    const response = await fetch(`/api/tweets/media?url=${encodeURIComponent(photoUrl)}`);
    if (!response.ok) throw new Error("The post image could not be prepared. Choose another image or use the text image.");
    const blob = await response.blob();
    return normalizeCoinImage(new File([blob], "post-image", { type: blob.type }));
  }
  const canvas = document.createElement("canvas");
  canvas.width = 512; canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare the text image.");
  context.fillStyle = "#0052ff"; context.fillRect(0, 0, 512, 512);
  context.fillStyle = "#b8ceff"; context.font = "25px Arial";
  context.fillText(`@${source.author.handle}`, 64, 102, 384);
  context.fillStyle = "white"; context.font = "bold 32px Arial";
  const lines: string[] = [];
  for (const word of source.text.replace(/\s+/g, " ").trim().split(" ")) {
    const current = lines[lines.length - 1];
    if (!current || context.measureText(`${current} ${word}`).width > 384) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
    if (lines.length > 6) { lines.length = 6; break; }
  }
  (lines.length ? lines : ["An idea worth sharing"]).forEach((line, index) => context.fillText(line, 64, 168 + index * 43, 384));
  return canvas.toDataURL("image/webp", 0.9);
}

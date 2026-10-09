import { isAddress, zeroAddress, type Address } from "viem";

/** Announcement fallback remains visible while the market API is loading. */
export const PLATFORM_TOKEN_LAUNCH_AT = "2026-10-11T09:00:00.000Z";
export const PLATFORM_TOKEN_LAUNCHER: Address = "0x0fd79f3ceae7dda5cfc15b35188e67efac542573";

export type PlatformTokenInfo = { enabled: false } | {
  enabled: true;
  launchAt: string;
  launcher: Address;
  tokenAddress: Address | null;
};

export function parsePlatformTokenInfo(value: unknown): PlatformTokenInfo {
  if (!value || typeof value !== "object") throw new Error("Invalid platform token response.");
  const info = value as Record<string, unknown>;
  if (info.enabled === false) return { enabled: false };
  if (info.enabled !== true || typeof info.launchAt !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(info.launchAt)
    || !Number.isFinite(Date.parse(info.launchAt)) || typeof info.launcher !== "string"
    || !isAddress(info.launcher, { strict: false }) || info.launcher.toLowerCase() !== PLATFORM_TOKEN_LAUNCHER
    || (info.tokenAddress !== null && (typeof info.tokenAddress !== "string" || !isAddress(info.tokenAddress, { strict: false }) || info.tokenAddress.toLowerCase() === zeroAddress))) {
    throw new Error("Invalid platform token response.");
  }
  return { enabled: true, launchAt: info.launchAt, launcher: info.launcher as Address, tokenAddress: info.tokenAddress as Address | null };
}

export function canSelectPlatformToken(info: PlatformTokenInfo | null, wallet?: string | null): boolean {
  return Boolean(info?.enabled && !info.tokenAddress && wallet?.toLowerCase() === PLATFORM_TOKEN_LAUNCHER
    && info.launcher.toLowerCase() === PLATFORM_TOKEN_LAUNCHER);
}

import { type Address, getAddress, isAddress, zeroAddress } from "viem";
import { optionalEnv } from "../env";

export interface PlatformTokenConfig { launchAt: string; launcher: Address }

/** Announcement settings are public. An incomplete optional feature must not stop the API. */
export function platformTokenConfig(chainId: number): PlatformTokenConfig | null {
  if (chainId !== 8453) return null;
  const launchAt = optionalEnv("MEMEFUN_PLATFORM_TOKEN_LAUNCH_AT");
  const launcher = optionalEnv("MEMEFUN_PLATFORM_TOKEN_LAUNCHER");
  if (!launchAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(launchAt)
    || !launcher || !isAddress(launcher, { strict: false }) || launcher.toLowerCase() === zeroAddress) return null;
  const date = new Date(launchAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== launchAt.replace("Z", ".000Z")) return null;
  return { launchAt: date.toISOString(), launcher: getAddress(launcher) };
}

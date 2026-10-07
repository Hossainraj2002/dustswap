import { type Address, type Hex, getAddress, isAddress, zeroAddress } from "viem";
import { envBool, envInt, optionalEnv } from "../env";

export interface LaunchCampaignConfig {
  contract: Address;
  expectedToken?: Address;
  tokenName?: string;
  tokenSymbol?: string;
  signerKey: Hex;
  requireTrade: boolean;
  ticketTtlSec: number;
}

export function campaignLabel(value: string | undefined, max: number): string | undefined {
  const label = value ? [...value].filter(c => { const code = c.charCodeAt(0); return code > 31 && (code < 127 || code > 159); }).join("").trim().slice(0, max) : undefined;
  return label || undefined;
}

/** No signing-key fallback. Absent or malformed optional campaign configuration stays disabled. */
export function launchCampaignConfig(): LaunchCampaignConfig | null {
  try {
    if (!envBool("MEMEFUN_LAUNCH_REWARD_ENABLED", false)) return null;
    const contract = optionalEnv("MEMEFUN_LAUNCH_REWARD_CONTRACT");
    const token = optionalEnv("MEMEFUN_LAUNCH_REWARD_TOKEN");
    const signerKey = optionalEnv("MEMEFUN_LAUNCH_REWARD_SIGNER_PRIVATE_KEY");
    if (!contract || !isAddress(contract, { strict: false }) || getAddress(contract) === zeroAddress
      || !signerKey || !/^0x[0-9a-fA-F]{64}$/.test(signerKey)
      || (token && (!isAddress(token, { strict: false }) || getAddress(token) === zeroAddress))) return null;
    return { contract: getAddress(contract), ...(token ? { expectedToken: getAddress(token) } : {}),
      tokenName: campaignLabel(optionalEnv("MEMEFUN_LAUNCH_REWARD_TOKEN_NAME"), 80),
      tokenSymbol: campaignLabel(optionalEnv("MEMEFUN_LAUNCH_REWARD_TOKEN_SYMBOL"), 20), signerKey: signerKey as Hex,
      requireTrade: envBool("MEMEFUN_LAUNCH_REWARD_REQUIRE_TRADE", false),
      ticketTtlSec: envInt("MEMEFUN_LAUNCH_REWARD_TICKET_TTL_SEC", 300, { min: 30, max: 900 }) };
  } catch {
    // An optional campaign typo must never prevent the ordinary market API from starting.
    // Do not echo malformed values: an operator may have pasted a secret into the wrong field.
    return null;
  }
}

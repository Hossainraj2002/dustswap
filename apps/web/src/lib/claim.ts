import { formatUnits, type Address, type Hex } from "viem";

/**
 * Client side of the Particle Points close-out distribution.
 *
 * The allocation list is static data produced by `apps/api/src/scripts/buildClaimAllocation.ts`
 * and served from `NEXT_PUBLIC_CLAIM_DATA_URL`. It is deliberately not an API call: the claim
 * window stays open for three months, and it must keep working whether or not the DustSwap API
 * is up.
 */

export const CLAIM_DISTRIBUTOR_ADDRESS = (process.env.NEXT_PUBLIC_CLAIM_DISTRIBUTOR_ADDRESS ||
  "") as Address;

/** Base path holding `eligibility.json` and `proofs/<lowercase address>.json`. */
export const CLAIM_DATA_URL = (process.env.NEXT_PUBLIC_CLAIM_DATA_URL || "/claim-data").replace(
  /\/$/,
  ""
);

/**
 * Master switch for the claim button. Checking eligibility is always available once a contract
 * is configured; actually claiming stays off until this is explicitly "1". Lets the checker go
 * live before the pool is funded and before claims are meant to open.
 */
export const CLAIM_ENABLED = process.env.NEXT_PUBLIC_CLAIM_ENABLED === "1";

export const CLAIM_TOKEN_SYMBOL = "USDC";
export const CLAIM_TOKEN_DECIMALS = 6;

/** Published minimum qualifying activity. Meeting either one qualifies. */
export const CLAIM_CRITERIA = {
  sweepUsd: 10,
  swapVolumeUsd: 100,
  streakSaves: 1,
} as const;

export const CLAIM_DISTRIBUTOR_ABI = [
  {
    type: "function",
    name: "checkEligibility",
    stateMutability: "nonpayable",
    inputs: [
      { name: "index", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "checkEligibility",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "index", type: "uint256" },
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isClaimed",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "merkleRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "claimDeadline",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "isFullyFunded",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "totalAllocation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalClaimed",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Display-only activity totals. Deliberately NOT part of the Merkle leaf, so they can never
 *  affect a payout, only what the page shows back to the person. */
export type ClaimStats = {
  /** Sweep volume in USD, as a decimal string. */
  sv: string;
  /** Swap volume in USD, as a decimal string. */
  wv: string;
  /** Streak Save count. */
  ss: number;
  /** 1 when the account qualified as an active community member. */
  cm: 0 | 1;
};

export type EligibilityIndex = {
  root: Hex;
  totalAllocation: string;
  totalAllocationUsd: string;
  accounts: number;
  addresses: number;
  builtAt: string;
  /** Eligibility only. Activity totals live in the per-address proof file, so one public
   *  download cannot yield every user trading history. */
  entries: Record<string, { i: number; a: string }>;
};

export type ClaimProof = ClaimStats & {
  /** Allocation index. The contract's claimed bitmap is keyed on this. */
  i: number;
  /** Allocation in token base units, as a decimal string. */
  a: string;
  /** Merkle proof. */
  p: Hex[];
};

let indexPromise: Promise<EligibilityIndex> | null = null;
let indexVersion = "";

/**
 * Both files are immutable for a given Merkle root, so they are cached hard and busted by the
 * root the CONTRACT reports. Without that, republishing the list would leave browsers holding
 * proofs that no longer verify, and the claim would revert with the user paying the gas.
 */
function versioned(path: string, version?: string) {
  return version ? `${CLAIM_DATA_URL}${path}?v=${version.slice(2, 18)}` : `${CLAIM_DATA_URL}${path}`;
}

export function loadEligibilityIndex(version?: string): Promise<EligibilityIndex> {
  const key = version ?? "";
  if (!indexPromise || indexVersion !== key) {
    indexVersion = key;
    indexPromise = fetch(versioned("/eligibility.json", version), { cache: "force-cache" })
      .then((res) => {
        if (!res.ok) throw new Error(`Allocation list unavailable (${res.status})`);
        return res.json() as Promise<EligibilityIndex>;
      })
      .catch((error) => {
        indexPromise = null;
        throw error;
      });
  }
  return indexPromise;
}

/** Fetches one address's proof. Only called for addresses that appear in the index. */
export async function loadClaimProof(address: Address, version?: string): Promise<ClaimProof> {
  const res = await fetch(versioned(`/proofs/${address.toLowerCase()}.json`, version), {
    cache: "force-cache",
  });
  if (!res.ok) throw new Error(`Proof unavailable (${res.status})`);
  return res.json() as Promise<ClaimProof>;
}

export function formatClaimAmount(baseUnits: bigint | string): string {
  const value = typeof baseUnits === "bigint" ? baseUnits : BigInt(baseUnits);
  const asNumber = Number(formatUnits(value, CLAIM_TOKEN_DECIMALS));
  return asNumber.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function isClaimConfigured(): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(CLAIM_DISTRIBUTOR_ADDRESS);
}

/**
 * Preview mode renders every screen from local state, with no contract and no wallet.
 *
 * It turns on by itself whenever no distributor address is configured, which is what makes the
 * page reviewable before anything is deployed. Once a real address is set it stays off unless
 * NEXT_PUBLIC_CLAIM_PREVIEW is explicitly "1", so it cannot reach production by accident.
 */
export function isPreviewMode(): boolean {
  if (process.env.NEXT_PUBLIC_CLAIM_PREVIEW === "1") return true;
  return !isClaimConfigured();
}

export const PREVIEW_SCENARIOS = [
  { id: "eligible", label: "Eligible" },
  { id: "community", label: "Community" },
  { id: "not-eligible", label: "Not eligible" },
  { id: "already-claimed", label: "Already claimed" },
  { id: "window-closed", label: "Window closed" },
  { id: "not-funded", label: "Not funded yet" },
] as const;

export type PreviewScenario = (typeof PREVIEW_SCENARIOS)[number]["id"];

/** A believable allocation for the preview, close to the real median payout. */
export const PREVIEW_AMOUNT = 12_400000n;
export const PREVIEW_STATS: ClaimStats = { sv: "284.60", wv: "4120.85", ss: 3, cm: 0 };
export const PREVIEW_STATS_COMMUNITY: ClaimStats = { sv: "0.00", wv: "63.21", ss: 0, cm: 1 };

/** Formats a USD activity total for display. */
export function formatUsdTotal(value: string | number): string {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
export const PREVIEW_ADDRESS = "0x5f2cD1a09B3a7F4e8c6D2b0E7A9c4F1d8B3e6A2c" as Address;

/** Days remaining until the claim window closes, floored at zero. */
export function daysUntil(deadlineSeconds: bigint | number): number {
  const deadlineMs = Number(deadlineSeconds) * 1000;
  return Math.max(0, Math.ceil((deadlineMs - Date.now()) / 86_400_000));
}

export function formatDeadline(deadlineSeconds: bigint | number): string {
  return new Date(Number(deadlineSeconds) * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAddress } from "viem";
import { blockscoutClient } from "./blockscoutClient";
import { runtimeCache } from "../utils/runtimeCache";

type AllowlistRow = {
  userAddress: string;
  totalUsdc: number;
};

type RewardRange = {
  min: number;
  max: number;
  label: string;
};

export type FootprintLookupSource = "saved_leaderboard" | "blockscout";

export type FootprintLookupResult = {
  address: string;
  eligible: boolean;
  source: FootprintLookupSource | null;
  rewardPoints: number;
  rangeMin: number | null;
  rangeMax: number | null;
  tierLabel: string | null;
  reason: string | null;
  allowlistTotalUsdc: number | null;
  transactionsCount: number | null;
  tokenTransfersCount: number | null;
  totalActivity: number | null;
};

const LOOKUP_TTL_MS = 6 * 60 * 60 * 1000;

function normalizeAddress(value: string) {
  return getAddress(value).toLowerCase();
}

function parseMetric(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function deterministicReward(seed: string, min: number, max: number) {
  if (max <= min) {
    return min;
  }

  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 12);
  const span = max - min + 1;
  return min + (Number.parseInt(hash, 16) % span);
}

function getSavedRewardRange(totalUsdc: number): RewardRange | null {
  if (totalUsdc > 100) {
    return { min: 25_000, max: 26_000, label: "Tier 4" };
  }

  if (totalUsdc > 50) {
    return { min: 15_000, max: 18_000, label: "Tier 3" };
  }

  if (totalUsdc > 20) {
    return { min: 12_000, max: 14_000, label: "Tier 2" };
  }

  if (totalUsdc > 4) {
    return { min: 7_000, max: 8_000, label: "Tier 1" };
  }

  return null;
}

function getFallbackRewardRange(totalActivity: number): RewardRange | null {
  if (totalActivity > 5_000) {
    return { min: 20_000, max: 21_000, label: "Onchain activity > 5,000" };
  }

  if (totalActivity > 1_000) {
    return { min: 10_000, max: 12_000, label: "Onchain activity > 1,000" };
  }

  if (totalActivity > 100) {
    return { min: 5_000, max: 6_000, label: "Onchain activity > 100" };
  }

  return null;
}

// The allowlist holds real wallet addresses and per-user volume, so it is not
// committed to the repo. Deploy it to the API host out-of-band (Railway volume,
// object storage, or FOOTPRINT_ALLOWLIST_PATH) — see apps/api/README.md.
function resolveAllowlistPath() {
  const candidates = [
    process.env.FOOTPRINT_ALLOWLIST_PATH,
    path.resolve(process.cwd(), "data", "all_time_user_totals.json"),
    path.resolve(process.cwd(), "apps", "api", "data", "all_time_user_totals.json"),
    path.resolve(process.cwd(), "..", "data", "all_time_user_totals.json"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// A missing or unreadable allowlist must not take the whole API down at import
// time. Lookups then fall back to the Blockscout on-chain activity path, which
// is exactly what non-allowlisted addresses already get.
function loadAllowlistTotals() {
  const totals = new Map<string, number>();
  const allowlistPath = resolveAllowlistPath();

  if (!allowlistPath) {
    console.warn(
      "[footprint-drop] all_time_user_totals.json not found — saved-leaderboard tiers are disabled and every lookup falls back to on-chain activity. Set FOOTPRINT_ALLOWLIST_PATH or place the file in apps/api/data/."
    );
    return totals;
  }

  let rows: AllowlistRow[];
  try {
    rows = JSON.parse(readFileSync(allowlistPath, "utf8")) as AllowlistRow[];
  } catch (error) {
    console.error(
      `[footprint-drop] failed to read allowlist at ${allowlistPath} — falling back to on-chain activity for every lookup.`,
      error
    );
    return totals;
  }

  for (const row of rows) {
    try {
      totals.set(normalizeAddress(row.userAddress), Number(row.totalUsdc || 0));
    } catch {
      // Ignore malformed rows and keep the lookup map resilient.
    }
  }

  return totals;
}

const allowlistTotals = loadAllowlistTotals();

export class FootprintAirdropService {
  async lookupReward(address: string): Promise<FootprintLookupResult> {
    const normalizedAddress = normalizeAddress(address);
    const cacheKey = `footprint-drop:${normalizedAddress}`;

    return runtimeCache.getOrSet(cacheKey, LOOKUP_TTL_MS, async () => {
      const savedTotalUsdc = allowlistTotals.get(normalizedAddress);

      if (typeof savedTotalUsdc === "number") {
        const savedRange = getSavedRewardRange(savedTotalUsdc);

        if (!savedRange) {
          return {
            address: normalizedAddress,
            eligible: false,
            source: "saved_leaderboard",
            rewardPoints: 0,
            rangeMin: null,
            rangeMax: null,
            tierLabel: null,
            reason:
              "Address found in the Baseapp Power user list, but it is below the current reward floor.",
            allowlistTotalUsdc: savedTotalUsdc,
            transactionsCount: null,
            tokenTransfersCount: null,
            totalActivity: null,
          };
        }

        return {
          address: normalizedAddress,
          eligible: true,
          source: "saved_leaderboard",
          rewardPoints: deterministicReward(
            `${normalizedAddress}:saved:${savedTotalUsdc}`,
            savedRange.min,
            savedRange.max
          ),
          rangeMin: savedRange.min,
          rangeMax: savedRange.max,
          tierLabel: savedRange.label,
          reason: null,
          allowlistTotalUsdc: savedTotalUsdc,
          transactionsCount: null,
          tokenTransfersCount: null,
          totalActivity: null,
        };
      }

      const payload = (await blockscoutClient.getAddressCounters(normalizedAddress)) as {
        transactions_count?: unknown;
        token_transfers_count?: unknown;
      };

      const transactionsCount = parseMetric(payload.transactions_count);
      const tokenTransfersCount = parseMetric(payload.token_transfers_count);
      const totalActivity = transactionsCount + tokenTransfersCount;
      const fallbackRange = getFallbackRewardRange(totalActivity);

      if (!fallbackRange) {
        return {
          address: normalizedAddress,
          eligible: false,
          source: "blockscout",
          rewardPoints: 0,
          rangeMin: null,
          rangeMax: null,
          tierLabel: null,
          reason:
            "This address does not unlock a Footprint Drop tier under the current onchain activity rules.",
          allowlistTotalUsdc: null,
          transactionsCount,
          tokenTransfersCount,
          totalActivity,
        };
      }

      return {
        address: normalizedAddress,
        eligible: true,
        source: "blockscout",
        rewardPoints: deterministicReward(
          `${normalizedAddress}:blockscout:${transactionsCount}:${tokenTransfersCount}`,
          fallbackRange.min,
          fallbackRange.max
        ),
        rangeMin: fallbackRange.min,
        rangeMax: fallbackRange.max,
        tierLabel: fallbackRange.label,
        reason: null,
        allowlistTotalUsdc: null,
        transactionsCount,
        tokenTransfersCount,
        totalActivity,
      };
    });
  }
}

export const footprintAirdropService = new FootprintAirdropService();

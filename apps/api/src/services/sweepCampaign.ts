import { createHash } from "crypto";
import {
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  isAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { isAllowedAppDomain } from "../config/appOrigins";
import { dbQuery } from "../lib/db";
import { runtimeCache } from "../utils/runtimeCache";
import {
  alchemyRpcRequest,
  baseRpcRequest,
  createBaseVerificationClient,
} from "../utils/baseRpc";
import { pointsEngine } from "./pointsEngine";
import { postgresDb } from "./postgres";

// ────────────────────────────────────────────────────────────────────────────
// DustSweep rewards campaign ("Sweep $500 → Earn $10").
//
// Money-safety invariants:
// * Campaign volume comes ONLY from on-chain-verified sweeps: the receipt is
//   fetched, the DustSwept/DustSweepExecuted event must be emitted by a known
//   DustSweep router, the event's `user` must equal the credited wallet, and
//   the USD value is re-derived from the event's grossAmountOut with trusted
//   anchor pricing. Client-reported values are never used.
// * Reward per account tops out at 2% of counted volume — the same rate as the
//   protocol fee charged on that volume — so the tier program is fee-neutral.
// * Every monetary value is integer micro-USD/micro-USDC (6 decimals).
// ────────────────────────────────────────────────────────────────────────────

const BASE_CHAIN_ID = 8453;
const USDC_BASE_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NATIVE_TOKEN_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const WETH_BASE_ADDRESS = "0x4200000000000000000000000000000000000006";

// Base output tokens the sweep UI offers. Anything else is rejected as an
// untrusted valuation anchor (a thin token's price cannot be trusted for USD).
const STABLE_OUTPUT_TOKENS = new Map<string, number>([
  [USDC_BASE_ADDRESS, 6],
  ["0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", 6], // USDT
  ["0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", 6], // USDbC
  ["0x50c5725949a6f0c72e6c4a641f24049a917db0cb", 18], // DAI
]);
const ETH_OUTPUT_TOKENS = new Map<string, number>([
  [WETH_BASE_ADDRESS, 18],
  [NATIVE_TOKEN_SENTINEL, 18],
]);

// V3 (DustSwapSweepRouter) emits DustSwept; V2 (DustSweepPermit2RouterV2)
// emits DustSweepExecuted. Identical shapes, and in both `user` is msg.sender —
// the connected wallet in the EOA, EIP-7702, and ERC-4337 lanes alike.
const SWEEP_EVENT_ABI = parseAbi([
  "event DustSwept(address indexed user, address indexed recipient, address indexed outputToken, uint256 routeCount, uint256 grossAmountOut, uint256 feeAmount, uint256 netAmountOut)",
  "event DustSweepExecuted(address indexed user, address indexed receiver, address indexed outputToken, uint256 routeCount, uint256 grossAmountOut, uint256 feeAmount, uint256 netAmountOut)",
]);

const CLAIM_STATEMENT = "DustSwap Sweep Campaign Claim";
const CLAIM_SIGNATURE_TTL_MS = 10 * 60 * 1000;
const CLAIM_FUTURE_SKEW_MS = 60 * 1000;
const CLAIM_RATE_LIMIT = 12;
const CLAIM_RATE_WINDOW_MS = 60 * 1000;
const CLAIM_GRACE_DAYS = 14;

const CAMPAIGN_CACHE_TTL_MS = 60 * 1000;
const LEADERBOARD_CACHE_TTL_MS = 60 * 1000;
const ETH_PRICE_CACHE_TTL_MS = 10 * 60 * 1000;

const VERIFY_MAX_ATTEMPTS = 20;
const VERIFY_BATCH_SIZE = 25;
const VERIFY_INTERVAL_MS = 60 * 1000;

const PAYOUT_INTERVAL_MS = 20 * 1000;
const PAYOUT_BATCH_SIZE = 10;
const PAYOUT_MAX_ATTEMPTS = 5;
const PAYOUT_RECEIPT_ATTEMPTS = 15;
const PAYOUT_RECEIPT_DELAY_MS = 4000;

const publicClient = createBaseVerificationClient();

export class SweepCampaignError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SweepCampaignError";
    this.status = status;
  }
}

// ── Row / config types ──────────────────────────────────────────────────────

type CampaignRow = {
  id: number;
  slug: string;
  name: string;
  chain_id: number;
  starts_at: string;
  ends_at: string;
  tier_config: TierConfig[];
  leaderboard_prizes: PrizeBand[];
  volume_cap_usd_micro: string | number;
  per_sweep_cap_usd_micro: string | number;
  is_active: boolean;
  finalized_at: string | null;
};

type TierConfig = {
  tier: number;
  thresholdUsdMicro: number;
  rewardUsdcMicro: number;
};

type PrizeBand = {
  rankFrom: number;
  rankTo: number;
  prizeUsdcMicro: number;
  prizePp: number;
};

type CreditRow = {
  id: number;
  campaign_id: number;
  chain_id: number;
  tx_hash: string;
  resolved_tx_hash: string | null;
  wallet_address: string;
  user_id: number | null;
  status: string;
  attempts: number;
};

type ClaimRow = {
  id: number;
  campaign_id: number;
  user_id: number;
  kind: string;
  tier: number;
  amount_usdc_micro: string | number;
  recipient_address: string;
  status: string;
  payout_attempt_tx_hash: string | null;
  payout_attempt_nonce: number | null;
  payout_tx_hash: string | null;
  payout_attempts: number;
  payout_error: string | null;
  approved_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
};

type CampaignPhase = "upcoming" | "live" | "grace" | "closed";

// ── Small helpers ───────────────────────────────────────────────────────────

function normalizeAddress(address: string) {
  return address.toLowerCase();
}

function isTxHash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function normalizeTxHash(value: string) {
  return value.toLowerCase() as Hex;
}

function toBigInt(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  return BigInt(String(value).split(".")[0] || "0");
}

function microToUsd(micro: bigint): number {
  return Number(micro) / 1_000_000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCampaignSlug() {
  return process.env.SWEEP_CAMPAIGN_SLUG || "sweep500-aug2026";
}

function getRouterAddresses(): Set<string> {
  const configured = (process.env.SWEEP_CAMPAIGN_ROUTER_ADDRESSES || "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => isAddress(address));

  const fallback = [
    process.env.DUST_SWEEP_ROUTER_V2_ADDRESS,
    process.env.DUST_SWEEP_ROUTER_V3_ADDRESS,
  ].filter((address): address is string => Boolean(address && isAddress(address)));

  const all = configured.length > 0 ? configured : fallback;
  return new Set(all.map(normalizeAddress));
}

function getMaxAutoPayoutMicro(): bigint {
  const parsed = Number(process.env.SWEEP_CAMPAIGN_MAX_AUTO_PAYOUT_USDC || "10");
  const usd = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
  return BigInt(Math.round(usd * 1_000_000));
}

function getDailySpendCapMicro(): bigint {
  const parsed = Number(process.env.SWEEP_CAMPAIGN_DAILY_SPEND_CAP_USDC || "500");
  const usd = Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
  return BigInt(Math.round(usd * 1_000_000));
}

function getMinBalanceMicro(): bigint {
  const parsed = Number(process.env.SWEEP_CAMPAIGN_MIN_BALANCE_USDC || "20");
  const usd = Number.isFinite(parsed) && parsed >= 0 ? parsed : 20;
  return BigInt(Math.round(usd * 1_000_000));
}

function payoutsEnabledByEnv() {
  return process.env.SWEEP_CAMPAIGN_PAYOUTS_ENABLED !== "false";
}

function getPayoutAccount() {
  const key = (process.env.SWEEP_CAMPAIGN_PAYOUT_PRIVATE_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    return null;
  }
  try {
    return privateKeyToAccount(key as Hex);
  } catch {
    return null;
  }
}

// ── Campaign config ─────────────────────────────────────────────────────────

function parseTierConfig(raw: unknown): TierConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => ({
      tier: Number((entry as TierConfig)?.tier || 0),
      thresholdUsdMicro: Number((entry as TierConfig)?.thresholdUsdMicro || 0),
      rewardUsdcMicro: Number((entry as TierConfig)?.rewardUsdcMicro || 0),
    }))
    .filter((entry) => entry.tier > 0 && entry.thresholdUsdMicro > 0 && entry.rewardUsdcMicro > 0)
    .sort((a, b) => a.tier - b.tier);
}

function parsePrizeBands(raw: unknown): PrizeBand[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => ({
      rankFrom: Number((entry as PrizeBand)?.rankFrom || 0),
      rankTo: Number((entry as PrizeBand)?.rankTo || 0),
      prizeUsdcMicro: Number((entry as PrizeBand)?.prizeUsdcMicro || 0),
      prizePp: Number((entry as PrizeBand)?.prizePp || 0),
    }))
    .filter((entry) => entry.rankFrom > 0 && entry.rankTo >= entry.rankFrom);
}

function findPrizeForRank(bands: PrizeBand[], rank: number): PrizeBand | null {
  return bands.find((band) => rank >= band.rankFrom && rank <= band.rankTo) || null;
}

function getCampaignPhase(campaign: CampaignRow, now = Date.now()): CampaignPhase {
  const startsAt = Date.parse(campaign.starts_at);
  const endsAt = Date.parse(campaign.ends_at);
  const graceEndsAt = endsAt + CLAIM_GRACE_DAYS * 24 * 60 * 60 * 1000;

  if (now < startsAt) return "upcoming";
  if (now <= endsAt) return "live";
  if (now <= graceEndsAt) return "grace";
  return "closed";
}

async function loadCampaignBySlug(slug: string): Promise<CampaignRow | null> {
  const { data, error } = await postgresDb
    .from("sweep_campaigns")
    .select("*")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Load sweep campaign: ${error.message}`);
  }

  return (data as CampaignRow | null) ?? null;
}

async function getCampaign(): Promise<CampaignRow | null> {
  const slug = getCampaignSlug();
  return runtimeCache.getOrSet(`sweep-campaign:config:${slug}`, CAMPAIGN_CACHE_TTL_MS, () =>
    loadCampaignBySlug(slug)
  );
}

/**
 * The campaign row when a sweep is still worth recording as a candidate.
 *
 * Accepts the grace window too, not just the live window: a sweep mined in the
 * campaign's final minutes can have its record-sweep call land after ends_at,
 * and dropping it here would silently lose real volume. Eligibility is decided
 * later by the BLOCK TIMESTAMP in verifyCredit, which is the only trustworthy
 * clock — so nothing outside the window can ever be credited by widening this.
 */
async function getIntakeCampaign(): Promise<CampaignRow | null> {
  const campaign = await getCampaign();
  if (!campaign) return null;
  const phase = getCampaignPhase(campaign);
  return phase === "live" || phase === "grace" ? campaign : null;
}

// ── Pricing ─────────────────────────────────────────────────────────────────

async function getEthPriceUsd(): Promise<number> {
  return runtimeCache.getOrSet("sweep-campaign:eth-price-usd", ETH_PRICE_CACHE_TTL_MS, async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      try {
        const response = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
          { signal: controller.signal }
        );
        if (response.ok) {
          const payload = (await response.json()) as {
            ethereum?: { usd?: number };
          };
          const price = Number(payload?.ethereum?.usd || 0);
          if (Number.isFinite(price) && price > 0) {
            return price;
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Fall through to the DB cache below.
    }

    // Fallback: the swap recorder keeps a daily WETH price cache. A slightly
    // stale price is acceptable; a made-up default is not, so if this also
    // fails we throw and the credit retries later.
    const { data } = await postgresDb
      .from("token_price_cache_daily")
      .select("price_usd")
      .eq("chain_id", BASE_CHAIN_ID)
      .eq("token_address", WETH_BASE_ADDRESS)
      .order("price_date", { ascending: false })
      .limit(1);

    const cached = Number((data as Array<{ price_usd: string | number }> | null)?.[0]?.price_usd || 0);
    if (Number.isFinite(cached) && cached > 0) {
      return cached;
    }

    throw new Error("ETH price unavailable");
  });
}

/**
 * USD value (6-dec micro) of `amount` raw units of the sweep output token.
 * Returns null when the output token is not a trusted valuation anchor.
 */
async function valueOutputToken(outputToken: string, amount: bigint): Promise<bigint | null> {
  const token = normalizeAddress(outputToken);

  const stableDecimals = STABLE_OUTPUT_TOKENS.get(token);
  if (stableDecimals !== undefined) {
    return (amount * 1_000_000n) / 10n ** BigInt(stableDecimals);
  }

  const ethDecimals = ETH_OUTPUT_TOKENS.get(token);
  if (ethDecimals !== undefined) {
    const price = await getEthPriceUsd();
    const priceMicro = BigInt(Math.round(price * 1_000_000));
    return (amount * priceMicro) / 10n ** BigInt(ethDecimals);
  }

  return null;
}

// ── Credit intake + verification ────────────────────────────────────────────

async function enqueueCandidate(input: {
  txHash?: string;
  userAddress?: string;
  chainId?: number;
}): Promise<void> {
  // Never let campaign bookkeeping affect the sweep flow.
  try {
    const campaign = await getIntakeCampaign();
    if (!campaign) return;
    if (Number(input.chainId) !== campaign.chain_id) return;
    if (!input.txHash || !isTxHash(input.txHash)) return;
    if (!input.userAddress || !isAddress(input.userAddress)) return;

    const { data, error } = await postgresDb
      .from("sweep_campaign_credits")
      .upsert(
        {
          campaign_id: campaign.id,
          chain_id: campaign.chain_id,
          tx_hash: normalizeTxHash(input.txHash),
          wallet_address: normalizeAddress(input.userAddress),
          status: "pending",
        },
        { onConflict: "campaign_id,chain_id,tx_hash", ignoreDuplicates: true }
      )
      .select("id");

    if (error) {
      console.error("[sweep-campaign] enqueue failed:", error.message);
      return;
    }

    const inserted = Array.isArray(data) ? (data[0] as { id: number } | undefined) : null;
    if (inserted?.id) {
      // Opportunistic fast path; the scheduler is the durable retry loop.
      void verifyCredit(inserted.id).catch(() => null);
    }
  } catch (error) {
    console.error("[sweep-campaign] enqueue error:", error);
  }
}

async function rejectCredit(creditId: number, reason: string) {
  await postgresDb
    .from("sweep_campaign_credits")
    .update({ status: "rejected", reject_reason: reason })
    .eq("id", creditId)
    .eq("status", "pending");
}

type ResolvedSweepTx = {
  resolvedTxHash: Hex;
  receipt: {
    status: string;
    blockNumber: bigint;
    logs: Array<{ address: string; data: Hex; topics: Hex[] }>;
  };
};

async function resolveSweepTransaction(txHash: Hex): Promise<ResolvedSweepTx | null> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    if (receipt) {
      return { resolvedTxHash: txHash, receipt };
    }
  } catch {
    // Not found as a plain tx — it may be an ERC-4337 userOp hash.
  }

  // eth_getUserOperationReceipt is a bundler API; only the Alchemy lane has it.
  try {
    const response = (await alchemyRpcRequest("eth_getUserOperationReceipt", [txHash], {
      timeoutMs: 10_000,
    })) as
      | { receipt?: { transactionHash?: string | null } | null; transactionHash?: string | null }
      | null;

    const resolvedHash = response?.receipt?.transactionHash || response?.transactionHash;
    if (resolvedHash && isTxHash(resolvedHash)) {
      const receipt = await publicClient.getTransactionReceipt({
        hash: normalizeTxHash(resolvedHash),
      });
      if (receipt) {
        return { resolvedTxHash: normalizeTxHash(resolvedHash), receipt };
      }
    }
  } catch {
    // Treated as transient below.
  }

  return null;
}

function decodeSweepEvent(receipt: ResolvedSweepTx["receipt"], routers: Set<string>) {
  for (const log of receipt.logs) {
    if (!routers.has(normalizeAddress(log.address))) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: SWEEP_EVENT_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });

      const args = decoded.args as unknown as {
        user: string;
        outputToken: string;
        grossAmountOut: bigint;
        feeAmount: bigint;
        netAmountOut: bigint;
      };

      return {
        user: normalizeAddress(args.user),
        outputToken: normalizeAddress(args.outputToken),
        grossAmountOut: args.grossAmountOut,
        netAmountOut: args.netAmountOut,
        feeAmount: args.feeAmount,
      };
    } catch {
      // A router can emit other events (RouteExecuted etc.) — keep scanning.
    }
  }

  return null;
}

async function verifyCredit(creditId: number): Promise<void> {
  // Atomically claim the row: bumps attempts and pushes next_retry_at so a
  // concurrent worker pass (or the fire-and-forget fast path) can't double-run.
  const claimed = await dbQuery<CreditRow & { attempts: number }>(
    `
      UPDATE sweep_campaign_credits
      SET attempts = attempts + 1,
          next_retry_at = NOW() + LEAST(POWER(2, attempts) * INTERVAL '30 seconds', INTERVAL '1 hour')
      WHERE id = $1
        AND status = 'pending'
        AND next_retry_at <= NOW()
      RETURNING *
    `,
    [creditId]
  );

  const credit = claimed.rows[0];
  if (!credit) return;

  const campaign = await getCampaign();
  if (!campaign || campaign.id !== credit.campaign_id) {
    await rejectCredit(credit.id, "campaign_inactive");
    return;
  }

  try {
    const resolved = await resolveSweepTransaction(normalizeTxHash(credit.tx_hash));
    if (!resolved) {
      // Transient: receipt not indexed yet (or a fake hash — the attempt cap
      // below turns that into a terminal rejection eventually). `attempts`
      // comes back already incremented by the claim UPDATE above.
      if (credit.attempts >= VERIFY_MAX_ATTEMPTS) {
        await rejectCredit(credit.id, "verification_timeout");
      }
      return;
    }

    if (resolved.receipt.status !== "success") {
      await rejectCredit(credit.id, "reverted");
      return;
    }

    const routers = getRouterAddresses();
    if (routers.size === 0) {
      console.error("[sweep-campaign] no router addresses configured");
      return;
    }

    const event = decodeSweepEvent(resolved.receipt, routers);
    if (!event) {
      await rejectCredit(credit.id, "not_dustsweep_router");
      return;
    }

    // The DustSwept event's `user` is msg.sender, so the chain itself names the
    // sweeper. Credit THAT address rather than the one the client claimed.
    //
    // This is deliberately not a match-or-reject check. record-sweep is
    // unauthenticated and a credit row is unique per tx hash, so rejecting on
    // mismatch would let anyone register a victim's tx under a junk address,
    // occupy the only row for it, and permanently deny that sweep. Taking the
    // sweeper from the event makes who submitted it irrelevant: the reward
    // always lands on the wallet that actually paid the fee.
    const sweeperAddress = event.user;

    if (event.feeAmount <= 0n) {
      await rejectCredit(credit.id, "fee_free");
      return;
    }

    // Count what the user ACTUALLY RECEIVED (net of the protocol fee), not the
    // gross output. Two reasons:
    //  1. Honesty: a user who receives $81.40 should see $81.40 of progress.
    //  2. Margin: reaching $500 net requires ~$510 gross, so the fee collected
    //     ($10.20) exceeds the $10 reward. Counting gross would break even
    //     exactly, leaving no room for price drift between quote and fill.
    const netValueMicro = await valueOutputToken(event.outputToken, event.netAmountOut);
    if (netValueMicro === null) {
      await rejectCredit(credit.id, "untrusted_output_token");
      return;
    }
    const feeValueMicro = (await valueOutputToken(event.outputToken, event.feeAmount)) ?? 0n;

    const block = await publicClient.getBlock({ blockNumber: resolved.receipt.blockNumber });
    const sweptAtMs = Number(block.timestamp) * 1000;
    const startsAt = Date.parse(campaign.starts_at);
    const endsAt = Date.parse(campaign.ends_at);
    if (sweptAtMs < startsAt || sweptAtMs > endsAt) {
      await rejectCredit(credit.id, "outside_window");
      return;
    }

    const perSweepCap = toBigInt(campaign.per_sweep_cap_usd_micro);
    const flagged = netValueMicro > perSweepCap;
    const valueMicro = flagged ? perSweepCap : netValueMicro;

    const user = await pointsEngine.getOrCreate(sweeperAddress);

    const { error: updateError } = await postgresDb
      .from("sweep_campaign_credits")
      .update({
        status: "verified",
        resolved_tx_hash: resolved.resolvedTxHash,
        // Overwrite the client-supplied hint with the on-chain sweeper.
        wallet_address: sweeperAddress,
        user_id: user.id,
        output_token: event.outputToken,
        gross_amount_out: event.grossAmountOut.toString(),
        net_amount_out: event.netAmountOut.toString(),
        fee_amount: event.feeAmount.toString(),
        value_usd_micro: valueMicro.toString(),
        fee_usd_micro: feeValueMicro.toString(),
        flagged,
        swept_at: new Date(sweptAtMs).toISOString(),
        verified_at: new Date().toISOString(),
      })
      .eq("id", credit.id)
      .eq("status", "pending");

    if (updateError) {
      const message = updateError.message.toLowerCase();
      if (message.includes("idx_scc_resolved_tx") || message.includes("duplicate key")) {
        // The same execution was already credited under another submitted hash
        // (userOp hash vs tx hash) — this row is a duplicate.
        await rejectCredit(credit.id, "duplicate_tx");
        return;
      }
      throw new Error(`Verify credit update: ${updateError.message}`);
    }

    runtimeCache.invalidatePrefix(`sweep-campaign:lb:${campaign.id}:`);
  } catch (error) {
    console.error(`[sweep-campaign] verify credit ${creditId} failed:`, error);
    if (credit.attempts >= VERIFY_MAX_ATTEMPTS) {
      await rejectCredit(credit.id, "verification_timeout");
    }
  }
}

async function runVerificationSweep(): Promise<void> {
  const { data, error } = await postgresDb
    .from("sweep_campaign_credits")
    .select("id")
    .eq("status", "pending")
    .lte("next_retry_at", new Date().toISOString())
    .order("next_retry_at", { ascending: true })
    .limit(VERIFY_BATCH_SIZE);

  if (error || !Array.isArray(data)) return;

  for (const row of data as Array<{ id: number }>) {
    try {
      await verifyCredit(row.id);
    } catch (err) {
      console.error("[sweep-campaign] verification sweep error:", err);
    }
  }
}

// ── Viewer status ───────────────────────────────────────────────────────────

async function resolveExistingUserId(address: string): Promise<number | null> {
  const { data } = await postgresDb.rpc("resolve_user_by_wallet", {
    p_wallet: normalizeAddress(address),
  });
  const rows = Array.isArray(data) ? (data as Array<{ id: number }>) : [];
  return rows[0]?.id ?? null;
}

function serializeCampaign(campaign: CampaignRow) {
  const tiers = parseTierConfig(campaign.tier_config);
  const prizes = parsePrizeBands(campaign.leaderboard_prizes);

  return {
    slug: campaign.slug,
    name: campaign.name,
    chainId: campaign.chain_id,
    startsAt: campaign.starts_at,
    endsAt: campaign.ends_at,
    claimGraceDays: CLAIM_GRACE_DAYS,
    volumeCapUsd: microToUsd(toBigInt(campaign.volume_cap_usd_micro)),
    tiers: tiers.map((tier) => ({
      tier: tier.tier,
      thresholdUsd: tier.thresholdUsdMicro / 1_000_000,
      rewardUsdc: tier.rewardUsdcMicro / 1_000_000,
    })),
    prizes: prizes.map((band) => ({
      rankFrom: band.rankFrom,
      rankTo: band.rankTo,
      prizeUsdc: band.prizeUsdcMicro / 1_000_000,
      prizePp: band.prizePp,
    })),
  };
}

type TierState = {
  tier: number;
  thresholdUsd: number;
  rewardUsdc: number;
  status: "locked" | "claimable" | "processing" | "paid" | "failed";
  payoutTxHash: string | null;
};

async function getStatusForAddress(address?: string | null) {
  const campaign = await getCampaign();
  if (!campaign) {
    return { success: true as const, active: false as const };
  }

  const phase = getCampaignPhase(campaign);
  if (phase === "closed") {
    return { success: true as const, active: false as const };
  }

  const payload: Record<string, unknown> = {
    success: true,
    active: phase === "live",
    phase,
    // Neutral availability signal only. Never expose the reason.
    payoutsAvailable: arePayoutsAvailable(),
    campaign: serializeCampaign(campaign),
  };

  if (!address || !isAddress(address)) {
    return payload;
  }

  const normalized = normalizeAddress(address);
  const userId = await resolveExistingUserId(normalized);

  let volumeMicro = 0n;
  let verifiedCount = 0;
  let claims: ClaimRow[] = [];

  if (userId !== null) {
    const totals = await dbQuery<{ volume: string | null; count: string }>(
      `
        SELECT COALESCE(SUM(c.value_usd_micro), 0)::BIGINT AS volume, COUNT(*) AS count
        FROM sweep_campaign_credits c
        JOIN sweep_campaigns camp ON camp.id = c.campaign_id
        WHERE c.campaign_id = $1
          AND c.user_id = $2
          AND c.status = 'verified'
          AND c.swept_at >= camp.starts_at
          AND c.swept_at <= camp.ends_at
      `,
      [campaign.id, userId]
    );
    volumeMicro = toBigInt(totals.rows[0]?.volume);
    verifiedCount = Number(totals.rows[0]?.count || 0);

    const { data: claimData } = await postgresDb
      .from("sweep_campaign_claims")
      .select("*")
      .eq("campaign_id", campaign.id)
      .eq("user_id", userId)
      .eq("kind", "tier");
    claims = Array.isArray(claimData) ? (claimData as ClaimRow[]) : [];
  }

  const pending = await dbQuery<{ count: string }>(
    `
      SELECT COUNT(*) AS count
      FROM sweep_campaign_credits
      WHERE campaign_id = $1 AND wallet_address = $2 AND status = 'pending'
    `,
    [campaign.id, normalized]
  );
  const pendingCount = Number(pending.rows[0]?.count || 0);

  const volumeCap = toBigInt(campaign.volume_cap_usd_micro);
  const cappedMicro = volumeMicro > volumeCap ? volumeCap : volumeMicro;
  const tiers = parseTierConfig(campaign.tier_config);
  const claimByTier = new Map(claims.map((claim) => [Number(claim.tier), claim]));

  let totalClaimableMicro = 0n;
  let totalPaidMicro = 0n;

  const tierStates: TierState[] = tiers.map((tier) => {
    const claim = claimByTier.get(tier.tier);
    let status: TierState["status"] = "locked";
    let payoutTxHash: string | null = null;

    if (claim) {
      payoutTxHash = claim.payout_tx_hash;
      if (claim.status === "paid") {
        status = "paid";
        totalPaidMicro += toBigInt(claim.amount_usdc_micro);
      } else if (claim.status === "failed") {
        status = "failed";
      } else {
        status = "processing";
      }
    } else if (cappedMicro >= BigInt(tier.thresholdUsdMicro)) {
      status = "claimable";
      totalClaimableMicro += BigInt(tier.rewardUsdcMicro);
    }

    return {
      tier: tier.tier,
      thresholdUsd: tier.thresholdUsdMicro / 1_000_000,
      rewardUsdc: tier.rewardUsdcMicro / 1_000_000,
      status,
      payoutTxHash,
    };
  });

  payload.viewer = {
    address: normalized,
    volumeUsd: microToUsd(volumeMicro),
    cappedVolumeUsd: microToUsd(cappedMicro),
    verifiedSweepCount: verifiedCount,
    pendingCount,
    tiers: tierStates,
    totalClaimableUsdc: microToUsd(totalClaimableMicro),
    totalPaidUsdc: microToUsd(totalPaidMicro),
  };

  return payload;
}

// ── Claims ──────────────────────────────────────────────────────────────────

type ParsedClaimMessage = {
  address: string;
  campaign: string;
  tier: number;
  timestamp: string;
  nonce: string;
  domain: string;
};

function parseClaimMessage(message: string): ParsedClaimMessage {
  const lines = message.split("\n").map((line) => line.trim());
  if (lines[0] !== CLAIM_STATEMENT) {
    throw new SweepCampaignError("Invalid claim message.", 401);
  }

  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    fields.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }

  const address = fields.get("address") || "";
  const campaign = fields.get("campaign") || "";
  const tier = Number.parseInt(fields.get("tier") || "", 10);
  const timestamp = fields.get("timestamp") || "";
  const nonce = fields.get("nonce") || "";
  const domain = fields.get("domain") || "";

  if (!isAddress(address) || !campaign || !Number.isFinite(tier) || !timestamp || !nonce || !domain) {
    throw new SweepCampaignError("Malformed claim message.", 401);
  }

  return { address, campaign, tier, timestamp, nonce, domain };
}

async function claimTier(input: {
  address?: string;
  tier?: number;
  message?: string;
  signature?: string;
  requestIp: string;
}) {
  if (!input.address || !input.message || !input.signature) {
    throw new SweepCampaignError("address, message, and signature are required", 400);
  }
  if (!isAddress(input.address)) {
    throw new SweepCampaignError("Invalid address", 400);
  }

  const normalized = normalizeAddress(input.address);
  const parsed = parseClaimMessage(input.message);

  if (normalizeAddress(parsed.address) !== normalized) {
    throw new SweepCampaignError("Claim address mismatch.", 401);
  }
  if (!isAllowedAppDomain(parsed.domain)) {
    throw new SweepCampaignError("Unexpected claim domain.", 401);
  }
  if (parsed.nonce.length < 8 || parsed.nonce.length > 128) {
    throw new SweepCampaignError("Invalid claim nonce.", 401);
  }
  if (input.tier !== undefined && Number(input.tier) !== parsed.tier) {
    throw new SweepCampaignError("Claim tier mismatch.", 400);
  }

  const timestampMs = Date.parse(parsed.timestamp);
  const now = Date.now();
  if (!Number.isFinite(timestampMs)) {
    throw new SweepCampaignError("Invalid claim timestamp.", 401);
  }
  if (now - timestampMs > CLAIM_SIGNATURE_TTL_MS) {
    throw new SweepCampaignError("Expired claim signature.", 401);
  }
  if (timestampMs - now > CLAIM_FUTURE_SKEW_MS) {
    throw new SweepCampaignError("Invalid claim timestamp.", 401);
  }

  const rateLimit = runtimeCache.consumeRateLimit(
    `sweep-campaign:claim:rate:${normalized}:${input.requestIp}`,
    CLAIM_RATE_LIMIT,
    CLAIM_RATE_WINDOW_MS
  );
  if (!rateLimit.allowed) {
    throw new SweepCampaignError("Too many claim attempts. Please wait.", 429);
  }

  const campaign = await getCampaign();
  if (!campaign || parsed.campaign !== campaign.slug) {
    throw new SweepCampaignError("Campaign not found.", 404);
  }

  const phase = getCampaignPhase(campaign);
  if (phase === "upcoming") {
    throw new SweepCampaignError("Campaign has not started yet.", 400);
  }
  if (phase === "closed") {
    throw new SweepCampaignError("The claim window for this campaign has closed.", 400);
  }

  const tiers = parseTierConfig(campaign.tier_config);
  const tierConfig = tiers.find((tier) => tier.tier === parsed.tier);
  if (!tierConfig) {
    throw new SweepCampaignError("Unknown tier.", 400);
  }

  // Don't accept a claim we cannot pay out promptly. Taking the signature and
  // then leaving the reward stuck reads as broken; asking the user to come back
  // shortly is honest and keeps their tier claimable. The reason stays internal.
  if (!arePayoutsAvailable()) {
    throw new SweepCampaignError(
      "Reward claims are opening again shortly. Your progress is saved, please try again soon.",
      503
    );
  }

  const signatureHash = createHash("sha256")
    .update(`${input.message}|${input.signature.toLowerCase()}`)
    .digest("hex");

  if (runtimeCache.get(`sweep-campaign:claim:replay:${signatureHash}`)) {
    throw new SweepCampaignError("Claim signature was already used.", 401);
  }

  const valid = await publicClient.verifyMessage({
    address: input.address as `0x${string}`,
    message: input.message,
    signature: input.signature as Hex,
  });
  if (!valid) {
    throw new SweepCampaignError("Invalid claim signature.", 401);
  }

  runtimeCache.set(`sweep-campaign:claim:replay:${signatureHash}`, true, CLAIM_SIGNATURE_TTL_MS);

  // Unlock check runs against VERIFIED credits only, at claim time.
  const user = await pointsEngine.getOrCreate(normalized);
  const totals = await dbQuery<{ volume: string | null }>(
    `
      SELECT COALESCE(SUM(c.value_usd_micro), 0)::BIGINT AS volume
      FROM sweep_campaign_credits c
      JOIN sweep_campaigns camp ON camp.id = c.campaign_id
      WHERE c.campaign_id = $1
        AND c.user_id = $2
        AND c.status = 'verified'
        AND c.swept_at >= camp.starts_at
        AND c.swept_at <= camp.ends_at
    `,
    [campaign.id, user.id]
  );

  const volumeCap = toBigInt(campaign.volume_cap_usd_micro);
  let volumeMicro = toBigInt(totals.rows[0]?.volume);
  if (volumeMicro > volumeCap) volumeMicro = volumeCap;

  if (volumeMicro < BigInt(tierConfig.thresholdUsdMicro)) {
    throw new SweepCampaignError(
      `Tier ${tierConfig.tier} unlocks at $${tierConfig.thresholdUsdMicro / 1_000_000} of verified sweep volume.`,
      400
    );
  }

  const amountMicro = BigInt(tierConfig.rewardUsdcMicro);
  const status = amountMicro <= getMaxAutoPayoutMicro() ? "pending_payout" : "pending_approval";

  const { data, error } = await postgresDb
    .from("sweep_campaign_claims")
    .insert({
      campaign_id: campaign.id,
      user_id: user.id,
      kind: "tier",
      tier: tierConfig.tier,
      amount_usdc_micro: amountMicro.toString(),
      recipient_address: normalized,
      status,
      claim_signature_hash: signatureHash,
    })
    .select("*");

  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes("duplicate key") || message.includes("unique")) {
      throw new SweepCampaignError("This tier was already claimed.", 409);
    }
    throw new Error(`Insert claim: ${error.message}`);
  }

  const claim = (Array.isArray(data) ? data[0] : data) as ClaimRow;

  // Nudge the payout worker so instant claims feel instant.
  void processPayouts().catch(() => null);

  return {
    success: true as const,
    claim: {
      tier: Number(claim.tier),
      amountUsdc: microToUsd(toBigInt(claim.amount_usdc_micro)),
      status: claim.status,
    },
  };
}

// ── Leaderboard ─────────────────────────────────────────────────────────────

async function getLeaderboard(input: { page?: number; pageSize?: number; viewerAddress?: string | null }) {
  const campaign = await getCampaign();
  if (!campaign) {
    return { success: true as const, active: false as const, entries: [], viewer: null };
  }

  const page = Math.max(1, Math.floor(Number(input.page) || 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number(input.pageSize) || 50)));
  const offset = (page - 1) * pageSize;
  const prizes = parsePrizeBands(campaign.leaderboard_prizes);

  type LeaderboardRow = {
    rank: string | number;
    user_id: number;
    wallet_address: string;
    volume_usd_micro: string | number;
    sweep_count: string | number;
  };

  const entries = await runtimeCache.getOrSet(
    `sweep-campaign:lb:${campaign.id}:${page}:${pageSize}`,
    LEADERBOARD_CACHE_TTL_MS,
    async () => {
      const { data, error } = await postgresDb.rpc("get_sweep_campaign_leaderboard_page", {
        p_campaign_id: campaign.id,
        p_limit: pageSize,
        p_offset: offset,
      });
      if (error) {
        throw new Error(`Leaderboard page: ${error.message}`);
      }
      return (Array.isArray(data) ? data : []) as LeaderboardRow[];
    }
  );

  const serializedEntries = entries.map((entry) => {
    const rank = Number(entry.rank);
    const prize = findPrizeForRank(prizes, rank);
    return {
      rank,
      address: entry.wallet_address,
      volumeUsd: microToUsd(toBigInt(entry.volume_usd_micro)),
      sweepCount: Number(entry.sweep_count),
      prizeUsdc: prize ? prize.prizeUsdcMicro / 1_000_000 : null,
      prizePp: prize ? prize.prizePp : null,
    };
  });

  let viewer: {
    rank: number;
    address: string;
    volumeUsd: number;
    sweepCount: number;
    prizeUsdc: number | null;
    prizePp: number | null;
  } | null = null;

  if (input.viewerAddress && isAddress(input.viewerAddress)) {
    const viewerAddress = normalizeAddress(input.viewerAddress);
    const userId = await resolveExistingUserId(viewerAddress);
    if (userId !== null) {
      const { data } = await postgresDb.rpc("get_sweep_campaign_leaderboard_viewer", {
        p_campaign_id: campaign.id,
        p_user_id: userId,
      });
      const row = (Array.isArray(data) ? data[0] : null) as
        | { rank: string | number; volume_usd_micro: string | number; sweep_count: string | number }
        | null;
      if (row) {
        const rank = Number(row.rank);
        const prize = findPrizeForRank(prizes, rank);
        viewer = {
          rank,
          address: viewerAddress,
          volumeUsd: microToUsd(toBigInt(row.volume_usd_micro)),
          sweepCount: Number(row.sweep_count),
          prizeUsdc: prize ? prize.prizeUsdcMicro / 1_000_000 : null,
          prizePp: prize ? prize.prizePp : null,
        };
      }
    }
  }

  return {
    success: true as const,
    active: getCampaignPhase(campaign) === "live",
    phase: getCampaignPhase(campaign),
    campaign: { slug: campaign.slug, startsAt: campaign.starts_at, endsAt: campaign.ends_at },
    prizes: serializeCampaign(campaign).prizes,
    entries: serializedEntries,
    viewer,
    page,
    pageSize,
  };
}

// ── Automated payout worker ─────────────────────────────────────────────────

let payoutLoopRunning = false;
let payoutsPausedReason: string | null = null;
// Underfunded wallet. Kept separate from an admin pause so it can clear itself
// the moment a top-up lands, with no operator action required.
let fundingLowSince: number | null = null;

function pausePayouts(reason: string) {
  payoutsPausedReason = reason;
  console.error(`[sweep-campaign] payouts PAUSED: ${reason}`);
}

function resumePayouts() {
  payoutsPausedReason = null;
}

function markFundingLow(isLow: boolean) {
  if (isLow) {
    if (fundingLowSince === null) {
      fundingLowSince = Date.now();
      console.error("[sweep-campaign] payout wallet underfunded; claims will queue until topped up");
    }
    return;
  }

  if (fundingLowSince !== null) {
    fundingLowSince = null;
    console.log("[sweep-campaign] payout wallet funded again; resuming payouts");
  }
}

function getPayoutState() {
  const account = getPayoutAccount();
  return {
    enabled: payoutsEnabledByEnv() && Boolean(account),
    pausedReason: payoutsPausedReason,
    fundingLow: fundingLowSince !== null,
    fundingLowSince: fundingLowSince ? new Date(fundingLowSince).toISOString() : null,
    payoutAddress: account?.address ?? null,
  };
}

/**
 * Whether a claim submitted right now would be paid promptly.
 *
 * Exposed to the public status endpoint as a single boolean. It deliberately
 * carries NO reason: users must never be shown treasury state, and "the reward
 * wallet is empty" is both alarming and an invitation to probe. The UI turns
 * this into a neutral "opening soon".
 */
function arePayoutsAvailable() {
  const state = getPayoutState();
  return state.enabled && !state.pausedReason && !state.fundingLow;
}

async function getUsdcBalance(address: string): Promise<bigint> {
  const balance = await publicClient.readContract({
    address: USDC_BASE_ADDRESS as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  });
  return BigInt(balance);
}

/**
 * USDC spent today by the UNATTENDED payout path.
 *
 * Admin-approved claims are excluded on purpose. The daily cap exists to bound
 * what the worker can spend on its own while nobody is watching; it is not a
 * budget for money a human has already reviewed and released. Counting
 * approved prize payouts here would let one end-of-campaign batch consume the
 * whole day's allowance and stall ordinary tier claims.
 */
async function getDailySpendMicro(): Promise<bigint> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const result = await dbQuery<{ total: string | null }>(
    `
      SELECT COALESCE(SUM(amount_usdc_micro), 0)::BIGINT AS total
      FROM sweep_campaign_claims
      WHERE approved_at IS NULL
        AND ((status = 'paid' AND paid_at >= $1) OR status = 'sending')
    `,
    [dayStart.toISOString()]
  );

  return toBigInt(result.rows[0]?.total);
}

async function markClaimPaid(claimId: number, txHash: string) {
  await postgresDb
    .from("sweep_campaign_claims")
    .update({
      status: "paid",
      payout_tx_hash: txHash,
      paid_at: new Date().toISOString(),
      payout_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", claimId);
}

async function markClaimFailed(claimId: number, reason: string) {
  await postgresDb
    .from("sweep_campaign_claims")
    .update({
      status: "failed",
      payout_error: reason.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("id", claimId);
}

/**
 * Crash / stall recovery for claims stuck in 'sending'. A claim is only
 * requeued when the attempt tx provably cannot land anymore (its nonce was
 * consumed by a different tx) — otherwise re-sending could double-pay.
 */
async function recoverSendingClaims(account: { address: string }) {
  const { data } = await postgresDb
    .from("sweep_campaign_claims")
    .select("*")
    .eq("status", "sending");

  const rows = Array.isArray(data) ? (data as ClaimRow[]) : [];
  if (rows.length === 0) return;

  for (const claim of rows) {
    try {
      if (claim.payout_attempt_tx_hash) {
        try {
          const receipt = await publicClient.getTransactionReceipt({
            hash: claim.payout_attempt_tx_hash as Hex,
          });
          if (receipt) {
            if (receipt.status === "success") {
              await markClaimPaid(claim.id, claim.payout_attempt_tx_hash);
            } else {
              await markClaimFailed(claim.id, "payout transaction reverted");
            }
            continue;
          }
        } catch {
          // Receipt not found — fall through to the nonce check.
        }
      }

      if (claim.payout_attempt_nonce !== null && claim.payout_attempt_nonce !== undefined) {
        const nonceHex = (await baseRpcRequest("eth_getTransactionCount", [
          account.address,
          "latest",
        ])) as string;
        const currentNonce = Number.parseInt(nonceHex, 16);

        if (Number.isFinite(currentNonce) && currentNonce > Number(claim.payout_attempt_nonce)) {
          // One more receipt look before requeueing (races with mining).
          let landed = false;
          if (claim.payout_attempt_tx_hash) {
            try {
              const receipt = await publicClient.getTransactionReceipt({
                hash: claim.payout_attempt_tx_hash as Hex,
              });
              if (receipt) {
                landed = true;
                if (receipt.status === "success") {
                  await markClaimPaid(claim.id, claim.payout_attempt_tx_hash);
                } else {
                  await markClaimFailed(claim.id, "payout transaction reverted");
                }
              }
            } catch {
              // Still not found — the nonce went to a different tx.
            }
          }

          if (!landed) {
            if (claim.payout_attempts >= PAYOUT_MAX_ATTEMPTS) {
              await markClaimFailed(claim.id, "payout retry limit reached");
            } else {
              await postgresDb
                .from("sweep_campaign_claims")
                .update({
                  status: "pending_payout",
                  payout_attempt_tx_hash: null,
                  payout_attempt_nonce: null,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", claim.id)
                .eq("status", "sending");
            }
          }
        }
        // currentNonce <= attempt nonce: the tx can still mine. Leave it.
      }
    } catch (error) {
      console.error(`[sweep-campaign] recover claim ${claim.id} failed:`, error);
    }
  }
}

async function sendClaimPayout(
  account: ReturnType<typeof privateKeyToAccount>,
  claim: ClaimRow
): Promise<void> {
  const amount = toBigInt(claim.amount_usdc_micro);
  const recipient = normalizeAddress(claim.recipient_address);

  // Above the auto-payout cap, money only moves after a human approved the
  // claim (leaderboard prizes). Unapproved large claims stay queued.
  if (amount > getMaxAutoPayoutMicro() && !claim.approved_at) {
    return;
  }

  const balance = await getUsdcBalance(account.address);
  if (balance < amount) {
    // Underfunded is a TEMPORARY condition, not a fault: flag it so the UI can
    // say "opening soon" instead of spinning, and let the next loop retry. It
    // must never latch the worker off, or a top-up would not restart payouts.
    markFundingLow(true);
    return;
  }
  markFundingLow(false);
  if (balance - amount < getMinBalanceMicro()) {
    console.warn(
      `[sweep-campaign] payout wallet float low: $${microToUsd(balance - amount).toFixed(2)} after next send`
    );
  }

  // The daily cap throttles only the unattended tier drip. Leaderboard prizes
  // are a single batch paid after the campaign ends, and an admin has already
  // approved each exact amount, so the cap must not split that batch across
  // days. The wallet balance check above still applies to every payout.
  if (!claim.approved_at) {
    const dailySpend = await getDailySpendMicro();
    if (dailySpend + amount > getDailySpendCapMicro()) {
      console.warn("[sweep-campaign] daily auto-payout cap reached; claims stay queued until tomorrow");
      return;
    }
  }

  // Atomically move to 'sending' so a competing loop can't pick the same claim.
  const claimed = await dbQuery<{ id: number }>(
    `
      UPDATE sweep_campaign_claims
      SET status = 'sending', payout_attempts = payout_attempts + 1, updated_at = NOW()
      WHERE id = $1 AND status = 'pending_payout'
      RETURNING id
    `,
    [claim.id]
  );
  if (!claimed.rows[0]) return;

  try {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient as `0x${string}`, amount],
    });

    const [nonceHex, gasEstimate, fees] = await Promise.all([
      baseRpcRequest("eth_getTransactionCount", [account.address, "pending"]) as Promise<string>,
      publicClient.estimateGas({
        account: account.address as `0x${string}`,
        to: USDC_BASE_ADDRESS as `0x${string}`,
        data,
      }) as Promise<bigint>,
      publicClient.estimateFeesPerGas() as Promise<{
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
      }>,
    ]);

    const nonce = Number.parseInt(nonceHex, 16);
    const serialized = await account.signTransaction({
      chainId: base.id,
      type: "eip1559",
      to: USDC_BASE_ADDRESS as `0x${string}`,
      data,
      value: 0n,
      nonce,
      gas: (gasEstimate * 130n) / 100n,
      maxFeePerGas: (fees.maxFeePerGas * 150n) / 100n,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const attemptHash = keccak256(serialized);

    // Persist the attempt BEFORE broadcasting: if the process dies right after
    // the send, recovery finds the hash and never pays twice.
    await postgresDb
      .from("sweep_campaign_claims")
      .update({
        payout_attempt_tx_hash: attemptHash,
        payout_attempt_nonce: nonce,
        updated_at: new Date().toISOString(),
      })
      .eq("id", claim.id);

    await baseRpcRequest("eth_sendRawTransaction", [serialized], { timeoutMs: 15_000 });

    for (let attempt = 0; attempt < PAYOUT_RECEIPT_ATTEMPTS; attempt += 1) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: attemptHash });
        if (receipt) {
          if (receipt.status === "success") {
            await markClaimPaid(claim.id, attemptHash);
          } else {
            await markClaimFailed(claim.id, "payout transaction reverted");
          }
          return;
        }
      } catch {
        // Not mined yet.
      }
      await sleep(PAYOUT_RECEIPT_DELAY_MS);
    }

    // Still unmined — leave in 'sending'; recovery resolves it next loop.
    console.warn(`[sweep-campaign] payout tx ${attemptHash} unmined after wait; left for recovery`);
  } catch (error) {
    console.error(`[sweep-campaign] payout for claim ${claim.id} failed:`, error);
    // If we never stored an attempt hash, nothing was broadcast — safe requeue.
    const { data } = await postgresDb
      .from("sweep_campaign_claims")
      .select("payout_attempt_tx_hash,payout_attempts")
      .eq("id", claim.id)
      .maybeSingle();
    const row = data as { payout_attempt_tx_hash: string | null; payout_attempts: number } | null;
    if (row && !row.payout_attempt_tx_hash) {
      if (row.payout_attempts >= PAYOUT_MAX_ATTEMPTS) {
        await markClaimFailed(claim.id, (error as Error).message || "payout failed");
      } else {
        await postgresDb
          .from("sweep_campaign_claims")
          .update({ status: "pending_payout", updated_at: new Date().toISOString() })
          .eq("id", claim.id)
          .eq("status", "sending");
      }
    }
    // With a stored attempt hash the broadcast may have gone out — recovery
    // owns it from here.
  }
}

async function processPayouts(): Promise<void> {
  if (payoutLoopRunning) return;
  if (!payoutsEnabledByEnv() || payoutsPausedReason) return;

  const account = getPayoutAccount();
  if (!account) return;

  payoutLoopRunning = true;
  try {
    await recoverSendingClaims(account);

    // Small tier claims pay automatically; approved prize claims (over the
    // auto cap) also flow through here — sendClaimPayout enforces the gate.
    const { data } = await postgresDb
      .from("sweep_campaign_claims")
      .select("*")
      .eq("status", "pending_payout")
      .order("created_at", { ascending: true })
      .limit(PAYOUT_BATCH_SIZE);

    const claims = Array.isArray(data) ? (data as ClaimRow[]) : [];
    for (const claim of claims) {
      if (payoutsPausedReason || !payoutsEnabledByEnv()) break;
      await sendClaimPayout(account, claim);
    }
  } catch (error) {
    console.error("[sweep-campaign] payout loop error:", error);
  } finally {
    payoutLoopRunning = false;
  }
}

// ── Admin operations ────────────────────────────────────────────────────────

async function listClaims(input: { status?: string | null }) {
  const campaign = await getCampaign();
  if (!campaign) {
    return { success: true as const, claims: [] };
  }

  let query = postgresDb
    .from("sweep_campaign_claims")
    .select("*")
    .eq("campaign_id", campaign.id)
    .order("created_at", { ascending: true })
    .limit(500);
  if (input.status) {
    query = query.eq("status", input.status);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`List claims: ${error.message}`);
  }

  return {
    success: true as const,
    payout: getPayoutState(),
    claims: (Array.isArray(data) ? (data as ClaimRow[]) : []).map((claim) => ({
      id: claim.id,
      kind: claim.kind,
      tier: Number(claim.tier),
      recipient: claim.recipient_address,
      amountUsdc: microToUsd(toBigInt(claim.amount_usdc_micro)),
      status: claim.status,
      payoutTxHash: claim.payout_tx_hash,
      payoutError: claim.payout_error,
      paidAt: claim.paid_at,
      createdAt: claim.created_at,
    })),
  };
}

async function listCredits(input: { status?: string | null; flagged?: boolean }) {
  const campaign = await getCampaign();
  if (!campaign) {
    return { success: true as const, credits: [] };
  }

  let query = postgresDb
    .from("sweep_campaign_credits")
    .select("*")
    .eq("campaign_id", campaign.id)
    .order("created_at", { ascending: false })
    .limit(500);
  if (input.status) {
    query = query.eq("status", input.status);
  }
  if (input.flagged) {
    query = query.eq("flagged", true);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`List credits: ${error.message}`);
  }

  return { success: true as const, credits: data ?? [] };
}

async function requeueCredit(input: { creditId?: number }) {
  const creditId = Number(input.creditId);
  if (!Number.isFinite(creditId) || creditId <= 0) {
    throw new SweepCampaignError("creditId is required", 400);
  }

  const result = await dbQuery<{ id: number }>(
    `
      UPDATE sweep_campaign_credits
      SET status = 'pending', reject_reason = NULL, attempts = 0, next_retry_at = NOW()
      WHERE id = $1 AND status IN ('pending', 'rejected')
      RETURNING id
    `,
    [creditId]
  );

  if (!result.rows[0]) {
    throw new SweepCampaignError("Credit not found or already verified.", 404);
  }

  void verifyCredit(creditId).catch(() => null);
  return { success: true as const };
}

async function approveClaims(input: { claimIds?: number[] }) {
  const ids = (input.claimIds || []).map(Number).filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) {
    throw new SweepCampaignError("claimIds is required", 400);
  }

  const result = await dbQuery<{ id: number }>(
    `
      UPDATE sweep_campaign_claims
      SET status = 'pending_payout', approved_at = NOW(), updated_at = NOW()
      WHERE id = ANY($1) AND status = 'pending_approval'
      RETURNING id
    `,
    [ids]
  );

  void processPayouts().catch(() => null);
  return { success: true as const, approved: result.rows.map((row) => row.id) };
}

/**
 * Manual fallback settle: the admin paid claims from their own wallet and
 * submits the tx hash. Fails closed — every claim's recipient must have
 * received at least the claim amount in USDC inside that one transaction,
 * with shared transfers counted once per recipient.
 */
async function settleClaimsManually(input: {
  claimIds?: number[];
  payoutTxHash?: string;
  paidNotes?: string | null;
}) {
  const ids = (input.claimIds || []).map(Number).filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) {
    throw new SweepCampaignError("claimIds is required", 400);
  }
  if (!input.payoutTxHash || !isTxHash(input.payoutTxHash)) {
    throw new SweepCampaignError("A valid payoutTxHash is required", 400);
  }
  const payoutTxHash = normalizeTxHash(input.payoutTxHash);

  const { data, error } = await postgresDb
    .from("sweep_campaign_claims")
    .select("*")
    .in("id", ids);
  if (error) {
    throw new Error(`Load claims: ${error.message}`);
  }

  const claims = (Array.isArray(data) ? (data as ClaimRow[]) : []).filter(
    (claim) => claim.status !== "paid"
  );
  if (claims.length === 0) {
    throw new SweepCampaignError("No unpaid claims found for those ids.", 404);
  }

  let receipt: { status?: string; logs?: unknown[] } | null = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: payoutTxHash });
      if (receipt) break;
    } catch {
      // Not indexed yet.
    }
    if (attempt < 5) await sleep(2500);
  }

  if (!receipt) {
    throw new SweepCampaignError("Payout transaction is not confirmed on Base yet.", 409);
  }
  if (receipt.status !== "success") {
    throw new SweepCampaignError("Payout transaction reverted on-chain.", 400);
  }

  const transferLogs = parseEventLogs({
    abi: erc20Abi,
    eventName: "Transfer",
    logs: (receipt.logs ?? []) as never,
  });

  const transferredByRecipient = new Map<string, bigint>();
  for (const log of transferLogs) {
    if (String(log.address).toLowerCase() !== USDC_BASE_ADDRESS) continue;
    const to = String((log.args as { to?: string }).to || "").toLowerCase();
    const value = (log.args as { value?: bigint }).value ?? 0n;
    transferredByRecipient.set(to, (transferredByRecipient.get(to) ?? 0n) + value);
  }

  const requiredByRecipient = new Map<string, bigint>();
  for (const claim of claims) {
    const recipient = normalizeAddress(claim.recipient_address);
    requiredByRecipient.set(
      recipient,
      (requiredByRecipient.get(recipient) ?? 0n) + toBigInt(claim.amount_usdc_micro)
    );
  }

  for (const [recipient, required] of requiredByRecipient) {
    const transferred = transferredByRecipient.get(recipient) ?? 0n;
    if (transferred < required) {
      throw new SweepCampaignError(
        `Transaction does not send enough USDC to ${recipient} (needs $${microToUsd(required).toFixed(2)}).`,
        400
      );
    }
  }

  const now = new Date().toISOString();
  for (const claim of claims) {
    await postgresDb
      .from("sweep_campaign_claims")
      .update({
        status: "paid",
        payout_tx_hash: payoutTxHash,
        paid_at: now,
        paid_notes: input.paidNotes?.trim() || null,
        payout_error: null,
        updated_at: now,
      })
      .eq("id", claim.id);
  }

  return { success: true as const, paid: claims.map((claim) => claim.id) };
}

/**
 * End-of-campaign finalization: snapshots the final top 50, creates USDC prize
 * claims (all pending_approval — a human approves before money moves) and
 * awards PP prizes. Guarded by finalized_at so it can only ever run once.
 */
async function finalizeCampaign() {
  const campaign = await getCampaign();
  if (!campaign) {
    throw new SweepCampaignError("Campaign not found.", 404);
  }
  if (Date.now() <= Date.parse(campaign.ends_at)) {
    throw new SweepCampaignError("Campaign has not ended yet.", 400);
  }

  const guard = await dbQuery<{ id: number }>(
    `
      UPDATE sweep_campaigns
      SET finalized_at = NOW()
      WHERE id = $1 AND finalized_at IS NULL
      RETURNING id
    `,
    [campaign.id]
  );
  if (!guard.rows[0]) {
    throw new SweepCampaignError("Campaign was already finalized.", 409);
  }

  const { data, error } = await postgresDb.rpc("get_sweep_campaign_leaderboard_page", {
    p_campaign_id: campaign.id,
    p_limit: 50,
    p_offset: 0,
  });
  if (error) {
    throw new Error(`Finalize leaderboard: ${error.message}`);
  }

  const prizes = parsePrizeBands(campaign.leaderboard_prizes);
  const rows = (Array.isArray(data) ? data : []) as Array<{
    rank: string | number;
    user_id: number;
    wallet_address: string;
    volume_usd_micro: string | number;
  }>;

  const created: Array<{ rank: number; address: string; prizeUsdc: number; prizePp: number }> = [];

  for (const row of rows) {
    const rank = Number(row.rank);
    const prize = findPrizeForRank(prizes, rank);
    if (!prize) continue;

    if (prize.prizeUsdcMicro > 0) {
      const { error: insertError } = await postgresDb
        .from("sweep_campaign_claims")
        .upsert(
          {
            campaign_id: campaign.id,
            user_id: row.user_id,
            kind: "prize",
            tier: rank,
            amount_usdc_micro: String(prize.prizeUsdcMicro),
            recipient_address: normalizeAddress(row.wallet_address),
            status: "pending_approval",
          },
          { onConflict: "campaign_id,user_id,kind,tier", ignoreDuplicates: true }
        );
      if (insertError) {
        console.error(`[sweep-campaign] prize claim for rank ${rank} failed:`, insertError.message);
      }
    }

    if (prize.prizePp > 0) {
      try {
        await pointsEngine.awardCustomPoints(row.wallet_address, prize.prizePp, "sweep_campaign_prize", {
          campaign: campaign.slug,
          rank,
          volumeUsd: microToUsd(toBigInt(row.volume_usd_micro)),
        });
      } catch (ppError) {
        console.error(`[sweep-campaign] PP prize for rank ${rank} failed:`, ppError);
      }
    }

    created.push({
      rank,
      address: row.wallet_address,
      prizeUsdc: prize.prizeUsdcMicro / 1_000_000,
      prizePp: prize.prizePp,
    });
  }

  runtimeCache.invalidate(`sweep-campaign:config:${campaign.slug}`);
  return { success: true as const, finalized: created };
}

// ── Schedulers ──────────────────────────────────────────────────────────────

let verificationTimer: ReturnType<typeof setInterval> | null = null;
let payoutTimer: ReturnType<typeof setInterval> | null = null;

function startSweepCampaignSchedulers() {
  if (!verificationTimer) {
    verificationTimer = setInterval(() => {
      void runVerificationSweep().catch((error) =>
        console.error("[sweep-campaign] verification scheduler error:", error)
      );
    }, VERIFY_INTERVAL_MS);
    verificationTimer.unref?.();
  }

  if (!payoutTimer) {
    payoutTimer = setInterval(() => {
      void processPayouts().catch((error) =>
        console.error("[sweep-campaign] payout scheduler error:", error)
      );
    }, PAYOUT_INTERVAL_MS);
    payoutTimer.unref?.();
  }
}

export const sweepCampaignService = {
  enqueueCandidate,
  getStatusForAddress,
  claimTier,
  getLeaderboard,
  listClaims,
  listCredits,
  requeueCredit,
  approveClaims,
  settleClaimsManually,
  finalizeCampaign,
  pausePayouts,
  resumePayouts,
  getPayoutState,
  startSweepCampaignSchedulers,
  // Exposed for tests / manual admin runs.
  verifyCredit,
  runVerificationSweep,
  processPayouts,
};

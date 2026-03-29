import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  http,
  isAddress,
  parseAbi,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { pointsEngine } from "./pointsEngine";
import { supabase } from "./supabase";

const BASE_RPC_URL =
  process.env.BASE_RPC_URL ||
  process.env.NEXT_PUBLIC_BASE_RPC_URL ||
  "https://mainnet.base.org";
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || "";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ETH_PLACEHOLDER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WETH_BASE = "0x4200000000000000000000000000000000000006";
const OPENOCEAN_EXCHANGE_V2 = "0x6352a56caadc4f1e25cd6c75970fa768a3304e64";
const OPENOCEAN_AGGREGATION_ROUTER = "0x6dd434082eab5cd134628d4b9a6e4d0813ef8b07";
const SWAP_EVENT_ABI = parseAbi([
  "event Swapped(address indexed sender, address indexed srcToken, address indexed dstToken, address dstReceiver, uint256 amount, uint256 spentAmount, uint256 returnAmount, uint256 minReturnAmount, uint256 guaranteedAmount, address referrer)",
]);
const PRICE_SCALE = 8;
const USD_SCALE = 6;
const MEMORY_PRICE_TTL_MS = 60 * 60 * 1000;
const RECEIPT_RETRY_DELAY_MS = 2500;
const RECEIPT_MAX_ATTEMPTS = 4;

const baseClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL),
});

type SwapRecordRow = {
  tx_hash: string;
  amount_usd: string | number | null;
  day_key: string;
  week_key: string;
};

type UserRow = { id: number };

type DailyVolumeRow = {
  total_usd: string | number | null;
  swap_count: number | string | null;
};

type AlltimeVolumeRow = DailyVolumeRow & {
  first_swap_at: string | null;
  last_swap_at: string | null;
};

type SweepHistoryRow = { id: number };

type DailyAssetPriceRow = {
  price_usd: string | number;
  source: string;
  metadata: Record<string, unknown> | null;
};

type PriceCacheEntry = {
  priceScaled: bigint;
  expiresAt: number;
  source: string;
  metadata: Record<string, unknown>;
};

type TokenMetadata = {
  address: string;
  symbol: string;
  decimals: number;
};

type RecordedSwap = {
  txHash: string;
  amountUsd: number;
  dayKey: string;
  weekKey: string;
  isNew: boolean;
};

type VolumeSummary = {
  totalUsd: number;
  swapCount: number;
};

type DecodedSwapEvent = {
  sender: string;
  srcToken: string;
  dstToken: string;
  dstReceiver: string;
  amount: bigint;
  spentAmount: bigint;
  returnAmount: bigint;
  minReturnAmount: bigint;
  guaranteedAmount: bigint;
  referrer: string;
  logIndex: number;
  emitterAddress: string;
};

const priceCache = new Map<string, PriceCacheEntry>();

class SwapRecorderError extends Error {}
class ValidationError extends SwapRecorderError {}
class PendingTransactionError extends SwapRecorderError {}
class UnprocessableSwapError extends SwapRecorderError {}

function normalizeAddress(address: string) {
  return address.toLowerCase();
}

function normalizeTxHash(txHash: string) {
  return txHash.toLowerCase();
}

function isTxHash(value: string) {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getIsoWeekKey(date: Date) {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utcDate.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

function parseScaledDecimal(
  value: string | number | null | undefined,
  scale: number
): bigint {
  if (value == null) {
    return 0n;
  }

  const normalized = String(value).trim().replace(/,/g, "");
  if (!normalized) {
    return 0n;
  }

  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const wholeDigits = whole.replace(/\D/g, "") || "0";
  const fractionDigits = fraction.replace(/\D/g, "").padEnd(scale, "0").slice(0, scale);
  const combined = `${wholeDigits}${fractionDigits}`.replace(/^0+(?=\d)/, "") || "0";
  const parsed = BigInt(combined);
  return negative ? -parsed : parsed;
}

function formatScaledDecimal(value: bigint, scale: number) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const padded = absolute.toString().padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale) || "0";
  const fraction = padded.slice(-scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function scaledDecimalToNumber(value: bigint, scale: number) {
  return Number(formatScaledDecimal(value, scale));
}

function getAssetPriceKey(address: string) {
  const normalized = normalizeAddress(address);
  return normalized === ZERO_ADDRESS ? ETH_PLACEHOLDER : normalized;
}

function getCoinGeckoId(address: string) {
  const normalized = normalizeAddress(address);
  if (normalized === ETH_PLACEHOLDER || normalized === ZERO_ADDRESS || normalized === WETH_BASE) {
    return "ethereum";
  }
  if (normalized === USDC_BASE) {
    return "usd-coin";
  }
  return null;
}

function getPriceCacheKey(address: string, dayKey: string) {
  return `${getAssetPriceKey(address)}:${dayKey}`;
}

function getRequestHeaders() {
  const headers: Record<string, string> = { accept: "application/json" };
  if (COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
    headers["x-cg-pro-api-key"] = COINGECKO_API_KEY;
  }
  return headers;
}

function calculateUsdAmountScaled(
  tokenAmountRaw: bigint,
  tokenDecimals: number,
  priceUsdScaled: bigint
) {
  if (tokenAmountRaw <= 0n || priceUsdScaled <= 0n) {
    return 0n;
  }

  const denominator = 10n ** BigInt(tokenDecimals + (PRICE_SCALE - USD_SCALE));
  const numerator = tokenAmountRaw * priceUsdScaled;
  return (numerator + (denominator / 2n)) / denominator;
}

async function getExistingSwap(txHash: string) {
  const { data, error } = await supabase
    .from("swap_transactions")
    .select("tx_hash, amount_usd, day_key, week_key")
    .eq("tx_hash", txHash)
    .maybeSingle();

  if (error) {
    throw new Error(`Load existing swap transaction: ${error.message}`);
  }

  return (data as SwapRecordRow | null) ?? null;
}

async function getUserByAddress(address: string) {
  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("address", normalizeAddress(address))
    .maybeSingle();

  if (error) {
    throw new Error(`Load user: ${error.message}`);
  }

  return (data as UserRow | null) ?? null;
}

async function waitForReceipt(txHash: Hex) {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < RECEIPT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await baseClient.getTransactionReceipt({ hash: txHash });
    } catch (error) {
      lastError = error as Error;
      if (attempt < RECEIPT_MAX_ATTEMPTS - 1) {
        await sleep(RECEIPT_RETRY_DELAY_MS);
      }
    }
  }

  throw new PendingTransactionError(
    lastError?.message || "Transaction receipt is not available yet"
  );
}

function decodeSwapEvent(receipt: Awaited<ReturnType<typeof baseClient.getTransactionReceipt>>) {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: SWAP_EVENT_ABI,
        data: log.data,
        topics: log.topics,
      });

      const args = decoded.args as {
        sender: string;
        srcToken: string;
        dstToken: string;
        dstReceiver: string;
        amount: bigint;
        spentAmount: bigint;
        returnAmount: bigint;
        minReturnAmount: bigint;
        guaranteedAmount: bigint;
        referrer: string;
      };

      return {
        sender: normalizeAddress(args.sender),
        srcToken: normalizeAddress(args.srcToken),
        dstToken: normalizeAddress(args.dstToken),
        dstReceiver: normalizeAddress(args.dstReceiver),
        amount: args.amount,
        spentAmount: args.spentAmount,
        returnAmount: args.returnAmount,
        minReturnAmount: args.minReturnAmount,
        guaranteedAmount: args.guaranteedAmount,
        referrer: normalizeAddress(args.referrer),
        logIndex: Number(log.logIndex),
        emitterAddress: normalizeAddress(log.address),
      } satisfies DecodedSwapEvent;
    } catch {
      // Ignore unrelated logs.
    }
  }

  throw new UnprocessableSwapError("Swapped event not found in transaction receipt");
}

async function getTokenMetadata(address: string): Promise<TokenMetadata> {
  const normalizedAddress = normalizeAddress(address);

  if (normalizedAddress === ZERO_ADDRESS || normalizedAddress === ETH_PLACEHOLDER) {
    return { address: normalizedAddress, symbol: "ETH", decimals: 18 };
  }

  try {
    const [decimals, symbol] = await Promise.all([
      baseClient.readContract({
        address: normalizedAddress as Hex,
        abi: erc20Abi,
        functionName: "decimals",
      }),
      baseClient.readContract({
        address: normalizedAddress as Hex,
        abi: erc20Abi,
        functionName: "symbol",
      }),
    ]);

    return {
      address: normalizedAddress,
      symbol: String(symbol),
      decimals: Number(decimals),
    };
  } catch {
    return {
      address: normalizedAddress,
      symbol: `${normalizedAddress.slice(0, 6)}...${normalizedAddress.slice(-4)}`,
      decimals: 18,
    };
  }
}

async function getCachedDailyPrice(address: string, dayKey: string) {
  const assetKey = getAssetPriceKey(address);
  const cacheKey = getPriceCacheKey(assetKey, dayKey);
  const cached = priceCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const { data, error } = await supabase
    .from("daily_asset_prices")
    .select("price_usd, source, metadata")
    .eq("asset_symbol", assetKey)
    .eq("price_date", dayKey)
    .maybeSingle();

  if (error) {
    throw new Error(`Load cached token price: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  const row = data as DailyAssetPriceRow;
  const entry: PriceCacheEntry = {
    priceScaled: parseScaledDecimal(row.price_usd, PRICE_SCALE),
    expiresAt: Date.now() + MEMORY_PRICE_TTL_MS,
    source: row.source || "coingecko",
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata
        : {},
  };

  priceCache.set(cacheKey, entry);
  return entry;
}

async function fetchCoinGeckoPrice(address: string) {
  const normalizedAddress = normalizeAddress(address);
  const coinId = getCoinGeckoId(normalizedAddress);

  if (coinId) {
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
        coinId
      )}&vs_currencies=usd`,
      { headers: getRequestHeaders() }
    );

    if (!response.ok) {
      throw new Error(`CoinGecko price lookup failed with ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, { usd?: number }>;
    const usdValue = payload?.[coinId]?.usd;
    if (typeof usdValue !== "number" || !Number.isFinite(usdValue) || usdValue <= 0) {
      throw new Error("CoinGecko did not return a usable USD price");
    }

    return {
      priceScaled: parseScaledDecimal(usdValue, PRICE_SCALE),
      source: "coingecko",
      metadata: {
        chain: "base",
        coinId,
        tokenAddress: normalizedAddress,
      } satisfies Record<string, unknown>,
    };
  }

  const response = await fetch(
    `https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${encodeURIComponent(
      normalizedAddress
    )}&vs_currencies=usd`,
    { headers: getRequestHeaders() }
  );

  if (!response.ok) {
    throw new Error(`CoinGecko token price lookup failed with ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, { usd?: number }>;
  const usdValue = payload?.[normalizedAddress]?.usd;
  if (typeof usdValue !== "number" || !Number.isFinite(usdValue) || usdValue <= 0) {
    throw new Error("CoinGecko did not return a usable token USD price");
  }

  return {
    priceScaled: parseScaledDecimal(usdValue, PRICE_SCALE),
    source: "coingecko",
    metadata: {
      chain: "base",
      tokenAddress: normalizedAddress,
    } satisfies Record<string, unknown>,
  };
}

async function getTokenPriceUsd(address: string, dayKey: string) {
  const assetKey = getAssetPriceKey(address);
  const cacheKey = getPriceCacheKey(assetKey, dayKey);
  const cached = await getCachedDailyPrice(assetKey, dayKey);

  if (cached) {
    return cached;
  }

  const fresh = await fetchCoinGeckoPrice(assetKey);
  const { error } = await supabase.from("daily_asset_prices").upsert(
    {
      asset_symbol: assetKey,
      price_date: dayKey,
      price_usd: formatScaledDecimal(fresh.priceScaled, PRICE_SCALE),
      source: fresh.source,
      metadata: fresh.metadata,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "asset_symbol,price_date" }
  );

  if (error) {
    throw new Error(`Store token price cache: ${error.message}`);
  }

  const entry: PriceCacheEntry = {
    ...fresh,
    expiresAt: Date.now() + MEMORY_PRICE_TTL_MS,
  };

  priceCache.set(cacheKey, entry);
  return entry;
}

async function upsertDailyVolumeFallback(
  userId: number,
  address: string,
  dayKey: string,
  weekKey: string,
  amountUsd: string
) {
  const { data, error } = await supabase
    .from("user_volume_daily")
    .select("total_usd, swap_count")
    .eq("user_id", userId)
    .eq("day_key", dayKey)
    .maybeSingle();

  if (error) {
    throw new Error(`Load daily volume aggregate: ${error.message}`);
  }

  const existing = (data as DailyVolumeRow | null) ?? null;
  const nextTotal =
    parseScaledDecimal(existing?.total_usd, USD_SCALE) + parseScaledDecimal(amountUsd, USD_SCALE);
  const nextSwapCount = Number(existing?.swap_count || 0) + 1;

  const { error: upsertError } = await supabase.from("user_volume_daily").upsert(
    {
      user_id: userId,
      address: normalizeAddress(address),
      day_key: dayKey,
      week_key: weekKey,
      total_usd: formatScaledDecimal(nextTotal, USD_SCALE),
      swap_count: nextSwapCount,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,day_key" }
  );

  if (upsertError) {
    throw new Error(`Upsert daily volume aggregate: ${upsertError.message}`);
  }
}

async function upsertDailyVolume(
  userId: number,
  address: string,
  dayKey: string,
  weekKey: string,
  amountUsd: string
) {
  const { error } = await supabase.rpc("upsert_daily_volume", {
    p_user_id: userId,
    p_address: normalizeAddress(address),
    p_day_key: dayKey,
    p_week_key: weekKey,
    p_amount_usd: amountUsd,
  });

  if (!error) {
    return;
  }

  await upsertDailyVolumeFallback(userId, address, dayKey, weekKey, amountUsd);
}

async function upsertAlltimeVolume(
  userId: number,
  address: string,
  occurredAt: string,
  amountUsd: string
) {
  const { data, error } = await supabase
    .from("user_volume_alltime")
    .select("total_usd, swap_count, first_swap_at, last_swap_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Load all-time volume aggregate: ${error.message}`);
  }

  const existing = (data as AlltimeVolumeRow | null) ?? null;
  const nextTotal =
    parseScaledDecimal(existing?.total_usd, USD_SCALE) + parseScaledDecimal(amountUsd, USD_SCALE);
  const nextSwapCount = Number(existing?.swap_count || 0) + 1;
  const firstSwapAt = existing?.first_swap_at || occurredAt;
  const previousLastSwapAt = existing?.last_swap_at ? new Date(existing.last_swap_at) : null;
  const nextOccurredAt = new Date(occurredAt);
  const lastSwapAt =
    previousLastSwapAt && previousLastSwapAt.getTime() > nextOccurredAt.getTime()
      ? previousLastSwapAt.toISOString()
      : occurredAt;

  const { error: upsertError } = await supabase.from("user_volume_alltime").upsert(
    {
      user_id: userId,
      address: normalizeAddress(address),
      total_usd: formatScaledDecimal(nextTotal, USD_SCALE),
      swap_count: nextSwapCount,
      first_swap_at: firstSwapAt,
      last_swap_at: lastSwapAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (upsertError) {
    throw new Error(`Upsert all-time volume aggregate: ${upsertError.message}`);
  }
}

async function mirrorSwapToActivityEvents(args: {
  userId: number;
  chainId: number;
  txHash: string;
  amountUsd: string;
  occurredAt: string;
  srcToken: TokenMetadata;
  dstToken: TokenMetadata;
  metadata: Record<string, unknown>;
}) {
  const { error } = await supabase.from("activity_events").upsert(
    {
      user_id: args.userId,
      event_type: "swap",
      source: "dustswap_swap",
      chain_id: args.chainId,
      tx_hash: args.txHash,
      amount_usd: args.amountUsd,
      occurred_at: args.occurredAt,
      metadata: {
        inputToken: args.srcToken.symbol,
        outputToken: args.dstToken.symbol,
        ...args.metadata,
      },
    },
    { onConflict: "tx_hash,event_type,source" }
  );

  if (error) {
    throw new Error(`Mirror swap to activity_events: ${error.message}`);
  }
}

async function mirrorSwapToSweepHistory(args: {
  userId: number;
  chainId: number;
  txHash: string;
  srcToken: TokenMetadata;
  dstToken: TokenMetadata;
  spentAmount: bigint;
  returnAmount: bigint;
  amountUsd: string;
}) {
  const { data, error } = await supabase
    .from("sweep_history")
    .select("id")
    .eq("tx_hash", args.txHash)
    .eq("type", "swap")
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Load sweep_history swap mirror: ${error.message}`);
  }

  const payload = {
    user_id: args.userId,
    tx_hash: args.txHash,
    chain_id: args.chainId,
    input_tokens: [
      {
        token: args.srcToken.address,
        amount: args.spentAmount.toString(),
        symbol: args.srcToken.symbol,
        decimals: args.srcToken.decimals,
      },
    ],
    output_token: args.dstToken.address,
    output_amount: args.returnAmount.toString(),
    output_value_usd: args.amountUsd,
    fee_amount: null,
    token_count: 1,
    type: "swap",
    status: "confirmed",
    points_earned: 0,
  };

  const existing = (data as SweepHistoryRow | null) ?? null;
  if (existing?.id) {
    const { error: updateError } = await supabase
      .from("sweep_history")
      .update(payload)
      .eq("id", existing.id);

    if (updateError) {
      throw new Error(`Update sweep_history swap mirror: ${updateError.message}`);
    }

    return;
  }

  const { error: insertError } = await supabase.from("sweep_history").insert(payload);
  if (insertError) {
    throw new Error(`Insert sweep_history swap mirror: ${insertError.message}`);
  }
}

export async function recordSwap(input: {
  address: string;
  txHash: string;
  chainId?: number;
}): Promise<RecordedSwap> {
  const normalizedAddress = normalizeAddress(input.address);
  const normalizedTxHash = normalizeTxHash(input.txHash);
  const resolvedChainId = Number.isFinite(input.chainId) ? Number(input.chainId) : base.id;

  if (!isAddress(normalizedAddress)) {
    throw new ValidationError("A valid wallet address is required");
  }

  if (!isTxHash(normalizedTxHash)) {
    throw new ValidationError("A valid transaction hash is required");
  }

  const existing = await getExistingSwap(normalizedTxHash);
  if (existing) {
    return {
      txHash: existing.tx_hash,
      amountUsd: Number(existing.amount_usd || 0),
      dayKey: existing.day_key,
      weekKey: existing.week_key,
      isNew: false,
    };
  }

  const user = await pointsEngine.getOrCreate(normalizedAddress);
  const receipt = await waitForReceipt(normalizedTxHash as Hex);
  if (receipt.status !== "success") {
    throw new UnprocessableSwapError("Swap transaction reverted");
  }

  const [transaction, block] = await Promise.all([
    baseClient.getTransaction({ hash: normalizedTxHash as Hex }),
    baseClient.getBlock({ blockNumber: receipt.blockNumber }),
  ]);

  const decodedSwap = decodeSwapEvent(receipt);
  const routerAddress = normalizeAddress(transaction.to || decodedSwap.emitterAddress);
  if (
    routerAddress !== OPENOCEAN_EXCHANGE_V2 &&
    routerAddress !== OPENOCEAN_AGGREGATION_ROUTER
  ) {
    throw new UnprocessableSwapError("Transaction was not sent through a supported OpenOcean router");
  }

  const [srcToken, dstToken] = await Promise.all([
    getTokenMetadata(decodedSwap.srcToken),
    getTokenMetadata(decodedSwap.dstToken),
  ]);

  const occurredAt = new Date(Number(block.timestamp) * 1000);
  const dayKey = getDayKey(occurredAt);
  const weekKey = getIsoWeekKey(occurredAt);
  const outPrice = await getTokenPriceUsd(decodedSwap.dstToken, dayKey);
  const amountUsdScaled = calculateUsdAmountScaled(
    decodedSwap.returnAmount,
    dstToken.decimals,
    outPrice.priceScaled
  );
  const amountUsd = formatScaledDecimal(amountUsdScaled, USD_SCALE);
  const occurredAtIso = occurredAt.toISOString();
  const metadata = {
    priceSource: outPrice.source,
    priceMetadata: outPrice.metadata,
    txFrom: transaction.from ? normalizeAddress(transaction.from) : null,
    sender: decodedSwap.sender,
    routerAddress,
    referrer: decodedSwap.referrer || null,
    spentAmount: decodedSwap.spentAmount.toString(),
    returnAmount: decodedSwap.returnAmount.toString(),
    blockNumber: Number(receipt.blockNumber),
    transactionIndex: Number(receipt.transactionIndex),
    logIndex: decodedSwap.logIndex,
  } satisfies Record<string, unknown>;

  const { error } = await supabase.from("swap_transactions").upsert(
    {
      user_id: user.id,
      address: normalizedAddress,
      tx_hash: normalizedTxHash,
      chain_id: resolvedChainId,
      router_address: routerAddress,
      sender_address: decodedSwap.sender,
      src_token_address: srcToken.address,
      src_token_symbol: srcToken.symbol,
      src_token_decimals: srcToken.decimals,
      dst_token_address: dstToken.address,
      dst_token_symbol: dstToken.symbol,
      dst_token_decimals: dstToken.decimals,
      dst_receiver: decodedSwap.dstReceiver,
      referrer: decodedSwap.referrer,
      amount_raw: decodedSwap.amount.toString(),
      spent_amount_raw: decodedSwap.spentAmount.toString(),
      return_amount_raw: decodedSwap.returnAmount.toString(),
      min_return_amount_raw: decodedSwap.minReturnAmount.toString(),
      guaranteed_amount_raw: decodedSwap.guaranteedAmount.toString(),
      amount_usd: amountUsd,
      day_key: dayKey,
      week_key: weekKey,
      block_number: Number(receipt.blockNumber),
      block_hash: receipt.blockHash,
      transaction_index: Number(receipt.transactionIndex),
      log_index: decodedSwap.logIndex,
      occurred_at: occurredAtIso,
      metadata,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tx_hash" }
  );

  if (error) {
    throw new Error(`Upsert swap transaction: ${error.message}`);
  }

  await upsertDailyVolume(user.id, normalizedAddress, dayKey, weekKey, amountUsd);
  await upsertAlltimeVolume(user.id, normalizedAddress, occurredAtIso, amountUsd);
  await mirrorSwapToActivityEvents({
    userId: user.id,
    chainId: resolvedChainId,
    txHash: normalizedTxHash,
    amountUsd,
    occurredAt: occurredAtIso,
    srcToken,
    dstToken,
    metadata,
  });
  await mirrorSwapToSweepHistory({
    userId: user.id,
    chainId: resolvedChainId,
    txHash: normalizedTxHash,
    srcToken,
    dstToken,
    spentAmount: decodedSwap.spentAmount,
    returnAmount: decodedSwap.returnAmount,
    amountUsd,
  });

  return {
    txHash: normalizedTxHash,
    amountUsd: scaledDecimalToNumber(amountUsdScaled, USD_SCALE),
    dayKey,
    weekKey,
    isNew: true,
  };
}

export async function getUserDailyVolume(userId: number, dayKey: string): Promise<VolumeSummary> {
  const { data, error } = await supabase
    .from("user_volume_daily")
    .select("total_usd, swap_count")
    .eq("user_id", userId)
    .eq("day_key", dayKey)
    .maybeSingle();

  if (error) {
    throw new Error(`Load user daily volume: ${error.message}`);
  }

  const row = (data as DailyVolumeRow | null) ?? null;
  return {
    totalUsd: Number(row?.total_usd || 0),
    swapCount: Number(row?.swap_count || 0),
  };
}

export async function getUserWeeklyVolume(userId: number, weekKey: string): Promise<VolumeSummary> {
  const { data, error } = await supabase
    .from("user_volume_daily")
    .select("total_usd, swap_count")
    .eq("user_id", userId)
    .eq("week_key", weekKey);

  if (error) {
    throw new Error(`Load user weekly volume: ${error.message}`);
  }

  return (data as DailyVolumeRow[] | null)?.reduce<VolumeSummary>(
    (summary, row) => ({
      totalUsd: summary.totalUsd + Number(row.total_usd || 0),
      swapCount: summary.swapCount + Number(row.swap_count || 0),
    }),
    { totalUsd: 0, swapCount: 0 }
  ) ?? { totalUsd: 0, swapCount: 0 };
}

export async function getUserAlltimeVolume(userId: number): Promise<VolumeSummary> {
  const { data, error } = await supabase
    .from("user_volume_alltime")
    .select("total_usd, swap_count")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Load user all-time volume: ${error.message}`);
  }

  const row = (data as DailyVolumeRow | null) ?? null;
  return {
    totalUsd: Number(row?.total_usd || 0),
    swapCount: Number(row?.swap_count || 0),
  };
}

export async function getSwapHistory(address: string, limit: number, offset: number) {
  const { data, error, count } = await supabase
    .from("swap_transactions")
    .select("*", { count: "exact" })
    .eq("address", normalizeAddress(address))
    .order("occurred_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Load swap history: ${error.message}`);
  }

  return {
    rows: data ?? [],
    total: count ?? 0,
  };
}

export async function getUserIdForAddress(address: string) {
  const user = await getUserByAddress(address);
  return user?.id ?? null;
}

export function getCurrentDayKey() {
  return getDayKey(new Date());
}

export function getCurrentWeekKey() {
  return getIsoWeekKey(new Date());
}

export const swapRecorderErrors = {
  PendingTransactionError,
  SwapRecorderError,
  UnprocessableSwapError,
  ValidationError,
};

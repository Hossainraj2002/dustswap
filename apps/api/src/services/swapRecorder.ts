import {
  decodeFunctionData,
  decodeEventLog,
  erc20Abi,
  isAddress,
  parseAbi,
  type Hex,
  type SignedAuthorizationList,
} from "viem";
import { base } from "viem/chains";
import { recoverAuthorizationAddress } from "viem/utils";
import {
  getPublicClientForSwapChain,
  getSwapChainConfig,
  isSupportedSwapChainId,
} from "../config/swapChains";
import { getSwapOwnRouterAddress } from "../config/swapownSources";
import { pointsEngine } from "./pointsEngine";
import { postgresDb } from "./postgres";

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || "";
const OPENOCEAN_API_BASE =
  process.env.OPENOCEAN_API_BASE || "https://open-api.openocean.finance/v3";
const OPENOCEAN_DETAIL_TIMEOUT_MS = Math.min(
  6_000,
  Math.max(1_000, Number(process.env.OPENOCEAN_DETAIL_TIMEOUT_MS || "3000"))
);
const OPENOCEAN_DETAIL_RETRY_ATTEMPTS = Math.min(
  6,
  Math.max(1, Number(process.env.OPENOCEAN_DETAIL_RETRY_ATTEMPTS || "4"))
);
const OPENOCEAN_DETAIL_RETRY_DELAY_MS = Math.min(
  5_000,
  Math.max(250, Number(process.env.OPENOCEAN_DETAIL_RETRY_DELAY_MS || "1250"))
);
const OPENOCEAN_REFERRER_ADDRESS = normalizeAddress(
  process.env.OPENOCEAN_REFERRER_ADDRESS ||
    process.env.NEXT_PUBLIC_OPENOCEAN_REFERRER_ADDRESS ||
    "0x0fd79f3ceaE7ddA5cFC15b35188E67EFAc542573"
);
const DUSTSWAP_BUILDER_CODE =
  process.env.BASE_BUILDER_CODE ||
  process.env.NEXT_PUBLIC_BASE_BUILDER_CODE ||
  process.env.NEXT_PUBLIC_BUILDER_CODE ||
  "bc_tpolfjho";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ETH_PLACEHOLDER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDT_BASE = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2";
const USDBC_BASE = "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca";
const DAI_BASE = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
const USDE_BASE = "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34";
const WBTC_BASE = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
const CBBTC_BASE = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const TBTC_BASE = "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b";
const CBETH_BASE = "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22";
const RETH_BASE = "0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c";
const WEETH_BASE = "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a";
const WSTETH_BASE = "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452";
const TRUSTED_BASE_VALUATION_TOKENS = new Set([
  USDC_BASE,
  USDT_BASE,
  USDBC_BASE,
  DAI_BASE,
  USDE_BASE,
  WBTC_BASE,
  CBBTC_BASE,
  TBTC_BASE,
  CBETH_BASE,
  RETH_BASE,
  WEETH_BASE,
  WSTETH_BASE,
]);
const BASE_USD_STABLE_TOKENS = new Set([
  USDC_BASE,
  USDT_BASE,
  USDBC_BASE,
  DAI_BASE,
  USDE_BASE,
]);
const OPENOCEAN_EXCHANGE_V2 = "0x6352a56caadc4f1e25cd6c75970fa768a3304e64";
const OPENOCEAN_AGGREGATION_ROUTER = "0x6dd434082eab5cd134628d4b9a6e4d0813ef8b07";
const OPENOCEAN_ZKSYNC_ROUTER = "0x36a1acbbcafca2468b85011ddd16e7cb4d673230";
const OPENOCEAN_POLYGON_ZKEVM_ROUTER = "0x6dd434082eab5cd134b33719ec1ff05fe985b97b";
const ENTRY_POINT_V06_ADDRESS = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789";
const DEFAULT_EIP7702_DELEGATION_MANAGER_ADDRESSES = [
  "0xdb9b1e94b5b69df7e401ddbede43491141047db3",
];
const DEFAULT_OPENOCEAN_ROUTER_ADDRESSES = [
  OPENOCEAN_EXCHANGE_V2,
  OPENOCEAN_AGGREGATION_ROUTER,
  OPENOCEAN_ZKSYNC_ROUTER,
  OPENOCEAN_POLYGON_ZKEVM_ROUTER,
];
const OPENOCEAN_ROUTER_ADDRESSES = new Set(
  (
    process.env.OPENOCEAN_ROUTER_ADDRESSES ||
    process.env.NEXT_PUBLIC_OPENOCEAN_ROUTER_ADDRESSES ||
    DEFAULT_OPENOCEAN_ROUTER_ADDRESSES.join(",")
  )
    .split(",")
    .map((address) => address.trim())
    .filter((address) => isAddress(address))
    .map((address) => normalizeAddress(address))
);
const EIP7702_DELEGATION_MANAGER_ADDRESSES = new Set(
  (
    process.env.EIP7702_DELEGATION_MANAGER_ADDRESSES ||
    DEFAULT_EIP7702_DELEGATION_MANAGER_ADDRESSES.join(",")
  )
    .split(",")
    .map((address) => address.trim())
    .filter((address) => isAddress(address))
    .map((address) => normalizeAddress(address))
);
const SWAP_EVENT_ABI = parseAbi([
  "event Swapped(address indexed sender, address indexed srcToken, address indexed dstToken, address dstReceiver, uint256 amount, uint256 spentAmount, uint256 returnAmount, uint256 minReturnAmount, uint256 guaranteedAmount, address referrer)",
]);
const DUSTSWAP_AGGREGATOR_EVENT_ABI = parseAbi([
  "event DustSwapSwap(address indexed user,address indexed receiver,address indexed tokenIn,address tokenOut,uint256 amountIn,uint256 grossAmountOut,uint256 netAmountOut,uint256 feeAmount,bytes32 referralCode,address referrer,string aggregatorName,string logoURI)",
]);
const ENTRY_POINT_HANDLE_OPS_ABI = parseAbi([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,uint256 callGasLimit,uint256 verificationGasLimit,uint256 preVerificationGas,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)",
]);
const SMART_WALLET_EXECUTION_ABI = parseAbi([
  "function execute(address target,uint256 value,bytes data)",
  "function executeBatch((address target,uint256 value,bytes data)[] calls)",
]);
const PRICE_SCALE = 8;
const USD_SCALE = 6;
const MEMORY_PRICE_TTL_MS = 60 * 60 * 1000;
const RECEIPT_RETRY_DELAY_MS = 1500;
const RECEIPT_MAX_ATTEMPTS = 20;
const DEFAULT_ETH_PRICE_USD = Number(process.env.DEFAULT_ETH_PRICE_USD || "3500");
const TOKEN_PRICE_CACHE_TABLE = "token_price_cache_daily";

// ── Swap USD sanity bounds ──────────────────────────────────────────────────
// DustSwap is a dust tool: real swaps are tiny (median ~$1, p99 ~$286). A swap
// conserves value, so the USD notional derived from the OUTPUT token must stay
// close to the value of the INPUT token. Illiquid meme/scam output tokens break
// this — CoinGecko returns an unreliable per-token price and the user receives an
// enormous token quantity, so `output_amount * price` explodes into millions or
// trillions of dollars. These bounds clamp the recorded USD back to reality
// BEFORE it is written to swap_transactions and every downstream aggregate.
const SWAP_VALUE_SANITY_THRESHOLD_USD = 1_000; // only scrutinize notionals above this

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

type DbErrorLike = {
  code?: string;
  message?: string;
  details?: string | null;
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

type SwapChainConfig = NonNullable<ReturnType<typeof getSwapChainConfig>>;
type SwapPublicClient = NonNullable<ReturnType<typeof getPublicClientForSwapChain>>;

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

type DecodedDustSwapAggregatorEvent = {
  user: string;
  receiver: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  grossAmountOut: bigint;
  netAmountOut: bigint;
  feeAmount: bigint;
  referralCode: string;
  referrer: string;
  aggregatorName: string;
  logoURI: string;
  logIndex: number;
  emitterAddress: string;
};

type TransactionRecord = Awaited<ReturnType<SwapPublicClient["getTransaction"]>>;
type TransactionReceiptRecord = Awaited<
  ReturnType<SwapPublicClient["getTransactionReceipt"]>
>;

type SmartWalletExecutionCall = {
  target: string;
  value: bigint;
  data: Hex;
};

type ResolvedSubmittedTransaction = {
  submittedHash: string;
  submittedKind: "transaction" | "user_operation";
  resolvedTxHash: string;
  userOperationHash: string | null;
  transaction: TransactionRecord;
  receipt: TransactionReceiptRecord;
};

type SwapRoutingContext = {
  routerAddress: string;
  senderAddress: string;
  viaSmartWallet: boolean;
  userOperationHash: string | null;
  builderCodeAttributed: boolean;
};

type OpenOceanTransactionDetail = {
  tx_hash?: string;
  usd_valuation?: number | string;
  referrer?: string | null;
  referrer_fee?: number | string | null;
  in_token_symbol?: string | null;
  out_token_symbol?: string | null;
  in_amount_value?: string | null;
  out_amount_value?: string | null;
  tx_profit?: string | number | null;
  tx_profit_valuation?: string | number | null;
  create_at?: string | null;
  update_at?: string | null;
};

const priceCache = new Map<string, PriceCacheEntry>();

class SwapRecorderError extends Error {}
class ValidationError extends SwapRecorderError {}
class PendingTransactionError extends SwapRecorderError {}
class UnprocessableSwapError extends SwapRecorderError {}

function normalizeAddress(address: string) {
  return address.toLowerCase();
}

function isExpectedOpenOceanReferrer(address: string) {
  return normalizeAddress(address) === OPENOCEAN_REFERRER_ADDRESS;
}

function toAsciiHex(value: string) {
  return Array.from(Buffer.from(value, "utf8"))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getBuilderCodeDataSuffix(code: string) {
  const encoded = toAsciiHex(code);
  const byteLength = Buffer.byteLength(code, "utf8");
  if (!encoded || byteLength <= 0 || byteLength > 255) {
    return "";
  }

  return `${encoded}${byteLength.toString(16).padStart(2, "0")}00${"8021".repeat(7)}`;
}

const DUSTSWAP_BUILDER_CODE_DATA_SUFFIX = getBuilderCodeDataSuffix(
  DUSTSWAP_BUILDER_CODE
);

function hasDustSwapBuilderCodeAttribution(data?: string | null) {
  if (!DUSTSWAP_BUILDER_CODE_DATA_SUFFIX || !data || data === "0x") {
    return false;
  }

  return data.toLowerCase().includes(DUSTSWAP_BUILDER_CODE_DATA_SUFFIX);
}

function normalizeTxHash(txHash: string) {
  return txHash.toLowerCase();
}

function isTxHash(value: string) {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function resolveInputChainId(chainId?: number | null) {
  const resolvedChainId = Number.isFinite(chainId) ? Number(chainId) : base.id;
  if (!isSupportedSwapChainId(resolvedChainId)) {
    throw new ValidationError(`Unsupported swap chain: ${resolvedChainId}`);
  }
  return resolvedChainId;
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

function isNativeAssetAddress(address: string) {
  const normalized = normalizeAddress(address);
  return normalized === ETH_PLACEHOLDER || normalized === ZERO_ADDRESS;
}

function isWrappedNativeAsset(address: string, chainConfig: SwapChainConfig) {
  const normalized = normalizeAddress(address);
  return Boolean(
    chainConfig.wrappedNativeTokens?.some((token) => normalizeAddress(token) === normalized)
  );
}

function getAssetPriceDbKey(address: string, chainConfig: SwapChainConfig) {
  const normalized = normalizeAddress(address);

  if (
    isNativeAssetAddress(normalized) ||
    isWrappedNativeAsset(normalized, chainConfig)
  ) {
    return chainConfig.nativeCoinGeckoId.toUpperCase();
  }

  if (chainConfig.id === base.id && BASE_USD_STABLE_TOKENS.has(normalized)) {
    return "USD_STABLE";
  }

  return null;
}

function isTrustedValuationToken(address: string, chainConfig: SwapChainConfig) {
  return (
    chainConfig.id === base.id && TRUSTED_BASE_VALUATION_TOKENS.has(normalizeAddress(address))
  );
}

function isUsdStableToken(address: string, chainConfig: SwapChainConfig) {
  return (
    chainConfig.id === base.id && BASE_USD_STABLE_TOKENS.has(normalizeAddress(address))
  );
}

function hasReliableUsdQuote(
  chainConfig: SwapChainConfig,
  address: string,
  priceSource?: string | null
) {
  void priceSource;
  return (
    getAssetPriceDbKey(address, chainConfig) !== null ||
    isTrustedValuationToken(address, chainConfig)
  );
}

function getCoinGeckoId(address: string, chainConfig: SwapChainConfig) {
  const normalized = normalizeAddress(address);
  if (
    isNativeAssetAddress(normalized) ||
    isWrappedNativeAsset(normalized, chainConfig)
  ) {
    return chainConfig.nativeCoinGeckoId;
  }
  if (chainConfig.id === base.id && normalized === USDC_BASE) {
    return "usd-coin";
  }
  return null;
}

function getPriceCacheKey(chainId: number, address: string, dayKey: string) {
  return `${chainId}:${getAssetPriceKey(address)}:${dayKey}`;
}

function isMissingTokenPriceCacheTable(error: DbErrorLike | null | undefined) {
  const message = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return (
    error?.code === "42P01" ||
    error?.code === "PGRST205" ||
    message.includes(TOKEN_PRICE_CACHE_TABLE)
  );
}

function isMissingChainAwareConflict(error: DbErrorLike | null | undefined) {
  const message = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return (
    error?.code === "42P10" ||
    message.includes("no unique or exclusion constraint") ||
    message.includes("on conflict specification")
  );
}

function getRequestHeaders() {
  const headers: Record<string, string> = { accept: "application/json" };
  if (COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
    headers["x-cg-pro-api-key"] = COINGECKO_API_KEY;
  }
  return headers;
}

async function fetchOpenOceanTransactionDetail(
  chainConfig: SwapChainConfig,
  txHash: string
) {
  if (!chainConfig.openOceanSlug) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENOCEAN_DETAIL_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${OPENOCEAN_API_BASE}/${encodeURIComponent(
        chainConfig.openOceanSlug
      )}/getTransaction?hash=${encodeURIComponent(txHash)}`,
      {
        headers: { accept: "application/json" },
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      code?: number;
      data?: OpenOceanTransactionDetail;
      error?: string;
      msg?: string;
    };

    if (payload.code && payload.code !== 200) {
      return null;
    }

    return payload.data ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchOpenOceanTransactionDetailWithRetry(
  chainConfig: SwapChainConfig,
  txHash: string
) {
  let latestDetail: OpenOceanTransactionDetail | null = null;

  for (let attempt = 1; attempt <= OPENOCEAN_DETAIL_RETRY_ATTEMPTS; attempt += 1) {
    const detail = await fetchOpenOceanTransactionDetail(chainConfig, txHash);
    if (detail) {
      latestDetail = detail;
      if (getOpenOceanAmountUsd(detail) !== null) {
        return detail;
      }
    }

    if (attempt < OPENOCEAN_DETAIL_RETRY_ATTEMPTS) {
      await sleep(OPENOCEAN_DETAIL_RETRY_DELAY_MS * attempt);
    }
  }

  return latestDetail;
}

function getOpenOceanAmountUsd(detail: OpenOceanTransactionDetail | null) {
  return getPositiveUsdValue(detail?.usd_valuation);
}

function getOpenOceanProtocolFeeUsdText(detail: OpenOceanTransactionDetail | null) {
  const value = detail?.tx_profit_valuation;
  return getPositiveUsdValue(value) === null ? null : String(value);
}

function getPositiveUsdValue(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getTrustedAmountMetadata(
  chainConfig: SwapChainConfig,
  txHash: string,
  amountUsd: number
) {
  return {
    amountUsdScaled: parseScaledDecimal(amountUsd, USD_SCALE),
    source: "openocean_wallet_history_usd_valuation",
    metadata: {
      chain: chainConfig.key,
      chainId: chainConfig.id,
      openOceanSlug: chainConfig.openOceanSlug || null,
      txHash,
    } satisfies Record<string, unknown>,
  };
}

function getOpenOceanDetailAmountMetadata(
  chainConfig: SwapChainConfig,
  detail: OpenOceanTransactionDetail,
  txHash: string,
  amountUsd: number
) {
  return {
    amountUsdScaled: parseScaledDecimal(amountUsd, USD_SCALE),
    source: "openocean_usd_valuation",
    metadata: {
      chain: chainConfig.key,
      chainId: chainConfig.id,
      openOceanSlug: chainConfig.openOceanSlug || null,
      txHash: detail.tx_hash || txHash,
      referrer: detail.referrer || null,
    } satisfies Record<string, unknown>,
  };
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

async function getExistingSwap(txHash: string, chainId?: number | null) {
  if (Number.isFinite(chainId)) {
    const { data: chainData, error: chainError } = await postgresDb
      .from("swap_transactions")
      .select("tx_hash, amount_usd, day_key, week_key")
      .eq("tx_hash", txHash)
      .eq("chain_id", Number(chainId))
      .limit(1)
      .maybeSingle();

    if (chainError) {
      throw new Error(`Load existing chain swap transaction: ${chainError.message}`);
    }

    if (chainData) {
      return chainData as SwapRecordRow;
    }

    return null;
  }

  const { data, error } = await postgresDb
    .from("swap_transactions")
    .select("tx_hash, amount_usd, day_key, week_key")
    .eq("tx_hash", txHash)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Load existing swap transaction: ${error.message}`);
  }

  return (data as SwapRecordRow | null) ?? null;
}

async function getUserByAddress(address: string) {
  // Merge-aware: a linked secondary wallet has no `users` row of its own (it
  // lives in user_wallets under the primary account, whose merged-away row is
  // tombstoned), so a raw users.address lookup returns null and the wallet would
  // report zero volume. Resolve through the account resolver so both wallets see
  // the account's (summed) volume. Volume itself is account-level (keyed by
  // user_id and summed at merge).
  const account = await pointsEngine.getAccountByWallet(address);
  return account ? ({ id: account.id } as UserRow) : null;
}

async function getTransactionContextByHash(client: SwapPublicClient, txHash: Hex) {
  const [transaction, receipt] = await Promise.all([
    client.getTransaction({ hash: txHash }),
    client.getTransactionReceipt({ hash: txHash }),
  ]);

  return {
    transaction,
    receipt,
  };
}

async function resolveUserOperationTransactionHash(
  client: SwapPublicClient,
  userOperationHash: Hex
) {
  try {
    const response = (await client.request({
      method: "eth_getUserOperationReceipt" as never,
      params: [userOperationHash] as never,
    })) as
      | {
          receipt?: {
            transactionHash?: string | null;
          } | null;
          transactionHash?: string | null;
        }
      | null;

    const resolvedHash = response?.receipt?.transactionHash || response?.transactionHash;
    return resolvedHash && isTxHash(resolvedHash) ? normalizeTxHash(resolvedHash) : null;
  } catch {
    return null;
  }
}

async function waitForResolvedTransaction(
  client: SwapPublicClient,
  submittedHash: Hex
): Promise<ResolvedSubmittedTransaction> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < RECEIPT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const direct = await getTransactionContextByHash(client, submittedHash);
      return {
        submittedHash,
        submittedKind: "transaction",
        resolvedTxHash: submittedHash,
        userOperationHash: null,
        transaction: direct.transaction,
        receipt: direct.receipt,
      };
    } catch (error) {
      lastError = error as Error;
    }

    const resolvedUserOperationHash = await resolveUserOperationTransactionHash(
      client,
      submittedHash
    );
    if (resolvedUserOperationHash) {
      try {
        const resolved = await getTransactionContextByHash(
          client,
          resolvedUserOperationHash as Hex
        );
        return {
          submittedHash,
          submittedKind: "user_operation",
          resolvedTxHash: resolvedUserOperationHash,
          userOperationHash: submittedHash,
          transaction: resolved.transaction,
          receipt: resolved.receipt,
        };
      } catch (error) {
        lastError = error as Error;
      }
    }

    if (attempt < RECEIPT_MAX_ATTEMPTS - 1) {
      await sleep(RECEIPT_RETRY_DELAY_MS);
    }
  }

  throw new PendingTransactionError(
    lastError?.message || "Transaction receipt is not available yet"
  );
}

function decodeSwapEvent(receipt: TransactionReceiptRecord) {
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

function decodeDustSwapAggregatorEvents(
  receipt: TransactionReceiptRecord,
  chainId: number
): DecodedDustSwapAggregatorEvent[] {
  const configuredRouter = getSwapOwnRouterAddress(chainId);
  if (!configuredRouter) {
    return [];
  }

  const normalizedRouter = normalizeAddress(configuredRouter);
  const events: DecodedDustSwapAggregatorEvent[] = [];

  for (const log of receipt.logs) {
    if (normalizeAddress(log.address) !== normalizedRouter) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: DUSTSWAP_AGGREGATOR_EVENT_ABI,
        data: log.data,
        topics: log.topics,
      });

      const args = decoded.args as {
        user: string;
        receiver: string;
        tokenIn: string;
        tokenOut: string;
        amountIn: bigint;
        grossAmountOut: bigint;
        netAmountOut: bigint;
        feeAmount: bigint;
        referralCode: string;
        referrer: string;
        aggregatorName: string;
        logoURI: string;
      };

      events.push({
        user: normalizeAddress(args.user),
        receiver: normalizeAddress(args.receiver),
        tokenIn: normalizeAddress(args.tokenIn),
        tokenOut: normalizeAddress(args.tokenOut),
        amountIn: args.amountIn,
        grossAmountOut: args.grossAmountOut,
        netAmountOut: args.netAmountOut,
        feeAmount: args.feeAmount,
        referralCode: args.referralCode,
        referrer: normalizeAddress(args.referrer),
        aggregatorName: args.aggregatorName,
        logoURI: args.logoURI,
        logIndex: Number(log.logIndex),
        emitterAddress: normalizeAddress(log.address),
      });
    } catch {
      // Ignore unrelated logs emitted by the same transaction.
    }
  }

  return events;
}

function decodeSmartWalletCalls(callData: Hex): SmartWalletExecutionCall[] {
  const decodedWalletCall = decodeFunctionData({
    abi: SMART_WALLET_EXECUTION_ABI,
    data: callData,
  });

  if (decodedWalletCall.functionName === "execute") {
    return [
      {
        target: normalizeAddress(decodedWalletCall.args[0]),
        value: decodedWalletCall.args[1],
        data: decodedWalletCall.args[2],
      },
    ];
  }

  return decodedWalletCall.args[0].map((call) => ({
    target: normalizeAddress(call.target),
    value: call.value,
    data: call.data,
  }));
}

function isSupportedDelegationManager(address: string) {
  return EIP7702_DELEGATION_MANAGER_ADDRESSES.has(normalizeAddress(address));
}

function isEip7702Transaction(
  transaction: TransactionRecord
): transaction is TransactionRecord & { type: "eip7702"; authorizationList?: SignedAuthorizationList } {
  return transaction.type === "eip7702";
}

async function resolveAuthorizedEip7702Addresses(
  transaction: TransactionRecord & { type: "eip7702"; authorizationList?: SignedAuthorizationList }
) {
  const authorizationList = transaction.authorizationList;
  if (!authorizationList?.length) {
    return [] as string[];
  }

  try {
    const addresses = await Promise.all(
      authorizationList.map(async (authorization: SignedAuthorizationList[number]) =>
        normalizeAddress(
          await recoverAuthorizationAddress({
            authorization,
          })
        )
      )
    );

    return [...new Set(addresses)];
  } catch {
    throw new UnprocessableSwapError("Unable to validate delegated transaction authorization");
  }
}

async function resolveSwapRoutingContext(args: {
  expectedAddress: string;
  transaction: TransactionRecord;
  decodedSwap: DecodedSwapEvent;
  resolvedTransaction: ResolvedSubmittedTransaction;
}): Promise<SwapRoutingContext> {
  const normalizedExpectedAddress = normalizeAddress(args.expectedAddress);
  const transactionTo = args.transaction.to ? normalizeAddress(args.transaction.to) : "";
  const transactionFrom = normalizeAddress(args.transaction.from);

  if (OPENOCEAN_ROUTER_ADDRESSES.has(transactionTo)) {
    if (
      transactionFrom !== normalizedExpectedAddress &&
      args.decodedSwap.sender !== normalizedExpectedAddress
    ) {
      throw new UnprocessableSwapError("Swap transaction does not belong to this wallet");
    }

    return {
      routerAddress: transactionTo,
      senderAddress: args.decodedSwap.sender,
      viaSmartWallet: false,
      userOperationHash: args.resolvedTransaction.userOperationHash,
      builderCodeAttributed: hasDustSwapBuilderCodeAttribution(args.transaction.input),
    };
  }

  if (isSupportedDelegationManager(transactionTo)) {
    if (!OPENOCEAN_ROUTER_ADDRESSES.has(args.decodedSwap.emitterAddress)) {
      throw new UnprocessableSwapError(
        "Delegated transaction did not execute a supported OpenOcean swap"
      );
    }

    if (args.decodedSwap.sender !== normalizedExpectedAddress) {
      throw new UnprocessableSwapError("Swap event sender does not match the connected wallet");
    }

    // The EIP-7702 authorization list only rides on the upgrade transaction
    // (type 0x4). Once an account is already delegated, the wallet's relayer
    // submits every later swap as a plain type-0x2 transaction to the same
    // delegation manager, carrying no authorization list to recover. Validate
    // the list only when it is actually present (type 0x4); for type-0x2
    // executions ownership is bound by the `decodedSwap.sender ===
    // expectedAddress` check above — under 7702 the OpenOcean `Swapped` sender
    // is the delegated EOA itself, so a foreign swap cannot match this wallet.
    if (isEip7702Transaction(args.transaction)) {
      const authorizedAddresses = await resolveAuthorizedEip7702Addresses(args.transaction);
      if (
        authorizedAddresses.length > 0 &&
        !authorizedAddresses.includes(normalizedExpectedAddress)
      ) {
        throw new UnprocessableSwapError(
          "Delegated transaction authorization does not belong to this wallet"
        );
      }
    }

    return {
      routerAddress: args.decodedSwap.emitterAddress,
      senderAddress: args.decodedSwap.sender,
      viaSmartWallet: false,
      userOperationHash: args.resolvedTransaction.userOperationHash,
      builderCodeAttributed: hasDustSwapBuilderCodeAttribution(args.transaction.input),
    };
  }

  if (
    transactionTo !== ENTRY_POINT_V06_ADDRESS ||
    !args.transaction.input ||
    args.transaction.input === "0x"
  ) {
    throw new UnprocessableSwapError("Transaction was not sent through a supported OpenOcean router");
  }

  try {
    const decodedEntryPointCall = decodeFunctionData({
      abi: ENTRY_POINT_HANDLE_OPS_ABI,
      data: args.transaction.input,
    });

    if (decodedEntryPointCall.functionName !== "handleOps") {
      throw new UnprocessableSwapError("Unsupported smart wallet transaction format");
    }

    const matchingOperation = decodedEntryPointCall.args[0].find(
      (operation) => normalizeAddress(operation.sender) === normalizedExpectedAddress
    );

    if (!matchingOperation) {
      throw new UnprocessableSwapError("Smart wallet operation does not belong to this wallet");
    }

    const walletCalls = decodeSmartWalletCalls(matchingOperation.callData);
    const matchingRouterCall = walletCalls.find(
      (call) =>
        OPENOCEAN_ROUTER_ADDRESSES.has(call.target) &&
        call.target === args.decodedSwap.emitterAddress
    );

    if (!matchingRouterCall) {
      throw new UnprocessableSwapError("Smart wallet operation did not execute an OpenOcean swap");
    }

    if (args.decodedSwap.sender !== normalizedExpectedAddress) {
      throw new UnprocessableSwapError("Swap event sender does not match the connected wallet");
    }

    return {
      routerAddress: matchingRouterCall.target,
      senderAddress: normalizeAddress(matchingOperation.sender),
      viaSmartWallet: true,
      userOperationHash: args.resolvedTransaction.userOperationHash,
      builderCodeAttributed:
        hasDustSwapBuilderCodeAttribution(matchingRouterCall.data) ||
        hasDustSwapBuilderCodeAttribution(args.transaction.input),
    };
  } catch (error) {
    if (error instanceof UnprocessableSwapError) {
      throw error;
    }

    throw new UnprocessableSwapError("Unable to decode smart wallet swap transaction");
  }
}

async function getTokenMetadata(
  client: SwapPublicClient,
  chainConfig: SwapChainConfig,
  address: string
): Promise<TokenMetadata> {
  const normalizedAddress = normalizeAddress(address);

  if (normalizedAddress === ZERO_ADDRESS || normalizedAddress === ETH_PLACEHOLDER) {
    return {
      address: normalizedAddress,
      symbol: chainConfig.chain.nativeCurrency.symbol || "ETH",
      decimals: chainConfig.chain.nativeCurrency.decimals || 18,
    };
  }

  try {
    const [decimals, symbol] = await Promise.all([
      client.readContract({
        address: normalizedAddress as Hex,
        abi: erc20Abi,
        functionName: "decimals",
      }),
      client.readContract({
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

async function getCachedDailyPrice(
  chainConfig: SwapChainConfig,
  address: string,
  dayKey: string
) {
  const assetKey = getAssetPriceKey(address);
  const cacheKey = getPriceCacheKey(chainConfig.id, assetKey, dayKey);
  const cached = priceCache.get(cacheKey);
  const dbKey = getAssetPriceDbKey(address, chainConfig);

  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const { data: tokenPriceData, error: tokenPriceError } = await postgresDb
    .from(TOKEN_PRICE_CACHE_TABLE)
    .select("price_usd, source, metadata")
    .eq("chain_id", chainConfig.id)
    .eq("token_address", assetKey)
    .eq("price_date", dayKey)
    .maybeSingle();

  if (tokenPriceError && !isMissingTokenPriceCacheTable(tokenPriceError as DbErrorLike)) {
    throw new Error(`Load token-address price cache: ${tokenPriceError.message}`);
  }

  if (tokenPriceData) {
    const row = tokenPriceData as DailyAssetPriceRow;
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

  if (!dbKey) {
    return null;
  }

  const { data, error } = await postgresDb
    .from("daily_asset_prices")
    .select("price_usd, source, metadata")
    .eq("asset_symbol", dbKey)
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

async function getLatestCachedPrice(chainConfig: SwapChainConfig, address: string) {
  const assetKey = getAssetPriceKey(address);
  const dbKey = getAssetPriceDbKey(address, chainConfig);

  const { data: tokenPriceData, error: tokenPriceError } = await postgresDb
    .from(TOKEN_PRICE_CACHE_TABLE)
    .select("price_usd, source, metadata")
    .eq("chain_id", chainConfig.id)
    .eq("token_address", assetKey)
    .order("price_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (tokenPriceError && !isMissingTokenPriceCacheTable(tokenPriceError as DbErrorLike)) {
    throw new Error(`Load fallback token-address price: ${tokenPriceError.message}`);
  }

  if (tokenPriceData) {
    const row = tokenPriceData as DailyAssetPriceRow;
    return {
      priceScaled: parseScaledDecimal(row.price_usd, PRICE_SCALE),
      source: row.source || "cached_fallback",
      metadata:
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? row.metadata
          : {},
    };
  }

  if (!dbKey) {
    return null;
  }

  const { data, error } = await postgresDb
    .from("daily_asset_prices")
    .select("price_usd, source, metadata")
    .eq("asset_symbol", dbKey)
    .order("price_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Load fallback token price: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  const row = data as DailyAssetPriceRow;
  return {
    priceScaled: parseScaledDecimal(row.price_usd, PRICE_SCALE),
    source: row.source || "cached_fallback",
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata
        : {},
  };
}

async function fetchCoinGeckoPrice(chainConfig: SwapChainConfig, address: string) {
  const normalizedAddress = normalizeAddress(address);
  const coinId = getCoinGeckoId(normalizedAddress, chainConfig);

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
        chain: chainConfig.key,
        chainId: chainConfig.id,
        coinId,
        tokenAddress: normalizedAddress,
      } satisfies Record<string, unknown>,
    };
  }

  if (!chainConfig.coinGeckoPlatformId) {
    throw new Error("CoinGecko token price platform is unavailable for this chain");
  }

  const response = await fetch(
    `https://api.coingecko.com/api/v3/simple/token_price/${encodeURIComponent(
      chainConfig.coinGeckoPlatformId
    )}?contract_addresses=${encodeURIComponent(normalizedAddress)}&vs_currencies=usd`,
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
      chain: chainConfig.key,
      chainId: chainConfig.id,
      platformId: chainConfig.coinGeckoPlatformId,
      tokenAddress: normalizedAddress,
    } satisfies Record<string, unknown>,
  };
}

async function getTokenPriceUsd(
  chainConfig: SwapChainConfig,
  address: string,
  dayKey: string
) {
  const assetKey = getAssetPriceKey(address);
  const dbKey = getAssetPriceDbKey(address, chainConfig);
  const cacheKey = getPriceCacheKey(chainConfig.id, assetKey, dayKey);
  const cached = await getCachedDailyPrice(chainConfig, assetKey, dayKey);

  if (cached) {
    return cached;
  }

  const persistPriceEntry = async (entryInput: {
    priceScaled: bigint;
    source: string;
    metadata: Record<string, unknown>;
  }) => {
    const tokenPricePayload = {
      chain_id: chainConfig.id,
      token_address: assetKey,
      price_date: dayKey,
      price_usd: formatScaledDecimal(entryInput.priceScaled, PRICE_SCALE),
      source: entryInput.source,
      metadata: entryInput.metadata,
      updated_at: new Date().toISOString(),
    };

    let tokenPriceCacheAvailable = true;
    const { error: tokenPriceError } = await postgresDb.from(TOKEN_PRICE_CACHE_TABLE).upsert(
      tokenPricePayload,
      { onConflict: "chain_id,token_address,price_date" }
    );

    if (tokenPriceError) {
      if (isMissingTokenPriceCacheTable(tokenPriceError as DbErrorLike)) {
        tokenPriceCacheAvailable = false;
      } else {
        throw new Error(`Store token-address price cache: ${tokenPriceError.message}`);
      }
    }

    if (!tokenPriceCacheAvailable && dbKey) {
      const { error } = await postgresDb.from("daily_asset_prices").upsert(
        {
          asset_symbol: dbKey,
          price_date: dayKey,
          price_usd: formatScaledDecimal(entryInput.priceScaled, PRICE_SCALE),
          source: entryInput.source,
          metadata: entryInput.metadata,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "asset_symbol,price_date" }
      );

      if (error) {
        throw new Error(`Store token price cache: ${error.message}`);
      }
    }

    const entry: PriceCacheEntry = {
      ...entryInput,
      expiresAt: Date.now() + MEMORY_PRICE_TTL_MS,
    };

    priceCache.set(cacheKey, entry);
    return entry;
  };

  if (isUsdStableToken(assetKey, chainConfig)) {
    return persistPriceEntry({
      priceScaled: parseScaledDecimal("1", PRICE_SCALE),
      source: "hardcoded_usd_stable",
      metadata: {
        chain: chainConfig.key,
        chainId: chainConfig.id,
        tokenAddress: assetKey,
      },
    });
  }

  try {
    const fresh = await fetchCoinGeckoPrice(chainConfig, assetKey);
    return persistPriceEntry(fresh);
  } catch {
    const fallback = await getLatestCachedPrice(chainConfig, assetKey);
    if (fallback) {
      return persistPriceEntry({
        priceScaled: fallback.priceScaled,
        source: `fallback_${fallback.source}`,
        metadata: {
          ...fallback.metadata,
          fallback: true,
          tokenAddress: assetKey,
        },
      });
    }

    if (
      (isNativeAssetAddress(assetKey) || isWrappedNativeAsset(assetKey, chainConfig)) &&
      chainConfig.nativeCoinGeckoId === "ethereum"
    ) {
      return persistPriceEntry({
        priceScaled: parseScaledDecimal(DEFAULT_ETH_PRICE_USD, PRICE_SCALE),
        source: "fallback_default_native",
        metadata: {
          chain: chainConfig.key,
          chainId: chainConfig.id,
          tokenAddress: assetKey,
          fallback: true,
        },
      });
    }

    throw new Error("Token USD price is unavailable");
  }
}

/**
 * Clamp a swap's output-derived USD notional back to a sane value before it is
 * persisted. A swap conserves value, so when the OUTPUT is not native /
 * wrapped-native / stablecoin, use the INPUT side only when it cannot create a
 * high-dollar arbitrary-token valuation. That keeps real stable/native swaps near
 * their spent notional while blocking arbitrary token or OpenOcean valuation
 * mistakes from inflating monitor/quest volume.
 * High arbitrary-output quotes that cannot be verified are recorded as zero.
 * OpenOcean referrer swaps use strict verification when OpenOcean has not yet
 * indexed the tx, because the output token quote is only a fallback.
 */
async function sanitizeSwapUsdScaled(args: {
  chainConfig: SwapChainConfig;
  dayKey: string;
  outputUsdScaled: bigint;
  outputAddress: string;
  outputDecimals?: number | null;
  outputAmountRaw?: bigint | null;
  outputPriceSource?: string | null;
  strictOutputVerification?: boolean;
  inputAddress: string;
  inputDecimals: number;
  inputAmountRaw: bigint;
}): Promise<bigint> {
  const value = args.outputUsdScaled;
  const thresholdScaled = parseScaledDecimal(String(SWAP_VALUE_SANITY_THRESHOLD_USD), USD_SCALE);
  const outputAddress = getAssetPriceKey(args.outputAddress);
  const inputAddress = getAssetPriceKey(args.inputAddress);
  const outputReliable = hasReliableUsdQuote(
    args.chainConfig,
    outputAddress,
    args.outputPriceSource
  );
  const inputIsStable = isUsdStableToken(inputAddress, args.chainConfig);
  const outputIsStable = isUsdStableToken(outputAddress, args.chainConfig);

  if (inputIsStable && args.inputAmountRaw > 0n) {
    return calculateUsdAmountScaled(
      args.inputAmountRaw,
      args.inputDecimals,
      parseScaledDecimal("1", PRICE_SCALE)
    );
  }

  if (outputIsStable && args.outputAmountRaw && args.outputDecimals != null) {
    return calculateUsdAmountScaled(
      args.outputAmountRaw,
      args.outputDecimals,
      parseScaledDecimal("1", PRICE_SCALE)
    );
  }

  if (outputReliable && !args.inputAmountRaw) {
    return value;
  }

  if (args.inputAmountRaw > 0n) {
    try {
      const inputPrice = await getTokenPriceUsd(args.chainConfig, inputAddress, args.dayKey);
      const inputUsdScaled = calculateUsdAmountScaled(
        args.inputAmountRaw,
        args.inputDecimals,
        inputPrice.priceScaled
      );
      if (hasReliableUsdQuote(args.chainConfig, inputAddress, inputPrice.source)) {
        return inputUsdScaled;
      }

      if (outputReliable) {
        return value;
      }

      if (inputUsdScaled === 0n) {
        // Input value rounds to ~$0 while output claims a large notional; the
        // output token was mispriced; the real routed value is dust.
        return 0n;
      }
      if (inputUsdScaled <= thresholdScaled) {
        if (!args.strictOutputVerification && value > 0n && value <= thresholdScaled) {
          return inputUsdScaled < value ? inputUsdScaled : value;
        }

        return inputUsdScaled;
      }

      if (!args.strictOutputVerification && value <= thresholdScaled) {
        return value;
      }

      return 0n;
    } catch {
      // Could not price the input; treat the high arbitrary-output quote as unverified.
    }
  }

  if (outputReliable) {
    return value;
  }

  if (!args.strictOutputVerification && value <= thresholdScaled) {
    return value;
  }

  return 0n;
}

async function upsertDailyVolumeFallback(
  userId: number,
  address: string,
  dayKey: string,
  weekKey: string,
  amountUsd: string
) {
  const { data, error } = await postgresDb
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

  const { error: upsertError } = await postgresDb.from("user_volume_daily").upsert(
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
  const { error } = await postgresDb.rpc("upsert_daily_volume", {
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
  const { data, error } = await postgresDb
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

  const { error: upsertError } = await postgresDb.from("user_volume_alltime").upsert(
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
  const payload = {
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
      inputTokenSymbol: args.srcToken.symbol,
      outputTokenSymbol: args.dstToken.symbol,
      inputTokenAddress: args.srcToken.address,
      outputTokenAddress: args.dstToken.address,
      ...args.metadata,
    },
  };

  const { error } = await postgresDb.from("activity_events").upsert(
    payload,
    { onConflict: "chain_id,tx_hash,event_type,source" }
  );

  if (error && isMissingChainAwareConflict(error as DbErrorLike)) {
    const { error: fallbackError } = await postgresDb.from("activity_events").upsert(
      payload,
      { onConflict: "tx_hash,event_type,source" }
    );

    if (fallbackError) {
      throw new Error(`Mirror swap to activity_events: ${fallbackError.message}`);
    }

    return;
  }

  if (error) {
    throw new Error(`Mirror swap to activity_events: ${error.message}`);
  }
}

async function upsertSwapTransaction(payload: Record<string, unknown>) {
  const { error } = await postgresDb.from("swap_transactions").upsert(
    payload,
    { onConflict: "chain_id,tx_hash" }
  );

  if (error && isMissingChainAwareConflict(error as DbErrorLike)) {
    const { error: fallbackError } = await postgresDb.from("swap_transactions").upsert(
      payload,
      { onConflict: "tx_hash" }
    );

    if (fallbackError) {
      throw new Error(`Upsert swap transaction: ${fallbackError.message}`);
    }

    return;
  }

  if (error) {
    throw new Error(`Upsert swap transaction: ${error.message}`);
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
  const { data, error } = await postgresDb
    .from("sweep_history")
    .select("id")
    .eq("tx_hash", args.txHash)
    .eq("chain_id", args.chainId)
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
    const { error: updateError } = await postgresDb
      .from("sweep_history")
      .update(payload)
      .eq("id", existing.id);

    if (updateError) {
      throw new Error(`Update sweep_history swap mirror: ${updateError.message}`);
    }

    return;
  }

  const { error: insertError } = await postgresDb.from("sweep_history").insert(payload);
  if (insertError) {
    throw new Error(`Insert sweep_history swap mirror: ${insertError.message}`);
  }
}

async function recordDustSwapAggregatorSwap(args: {
  user: UserRow;
  normalizedAddress: string;
  normalizedTxHash: string;
  resolvedChainId: number;
  chainConfig: SwapChainConfig;
  client: SwapPublicClient;
  resolvedTransaction: ResolvedSubmittedTransaction;
  blockTimestamp: bigint;
  events: DecodedDustSwapAggregatorEvent[];
}): Promise<RecordedSwap> {
  const primaryEvent = args.events[0];
  if (!primaryEvent) {
    throw new UnprocessableSwapError("DustSwap swap event not found");
  }

  const belongsToWallet = args.events.some(
    (event) =>
      event.user === args.normalizedAddress ||
      event.receiver === args.normalizedAddress
  );
  const txFrom = args.resolvedTransaction.transaction.from
    ? normalizeAddress(args.resolvedTransaction.transaction.from)
    : "";

  if (!belongsToWallet && txFrom !== args.normalizedAddress) {
    throw new UnprocessableSwapError("DustSwap swap transaction does not belong to this wallet");
  }

  const receipt = args.resolvedTransaction.receipt;
  const occurredAt = new Date(Number(args.blockTimestamp) * 1000);
  const dayKey = getDayKey(occurredAt);
  const weekKey = getIsoWeekKey(occurredAt);
  const occurredAtIso = occurredAt.toISOString();

  const [srcToken, primaryDstToken, outputData] = await Promise.all([
    getTokenMetadata(args.client, args.chainConfig, primaryEvent.tokenIn),
    getTokenMetadata(args.client, args.chainConfig, primaryEvent.tokenOut),
    Promise.all(
      args.events.map(async (event) => {
        const token = await getTokenMetadata(args.client, args.chainConfig, event.tokenOut);
        const price = await getTokenPriceUsd(args.chainConfig, event.tokenOut, dayKey);
        const amountUsdScaled = calculateUsdAmountScaled(
          event.netAmountOut,
          token.decimals,
          price.priceScaled
        );

        return {
          event,
          token,
          price,
          amountUsdScaled,
        };
      })
    ),
  ]);

  const rawAmountUsdScaled = outputData.reduce(
    (sum, item) => sum + item.amountUsdScaled,
    0n
  );
  const outputQuotesReliable = outputData.every((item) =>
    hasReliableUsdQuote(args.chainConfig, item.token.address, item.price.source)
  );
  const grossAmountOut = args.events.reduce((sum, event) => sum + event.grossAmountOut, 0n);
  const netAmountOut = args.events.reduce((sum, event) => sum + event.netAmountOut, 0n);
  const feeAmount = args.events.reduce((sum, event) => sum + event.feeAmount, 0n);
  const amountIn = primaryEvent.amountIn;
  const amountUsdScaled = await sanitizeSwapUsdScaled({
    chainConfig: args.chainConfig,
    dayKey,
    outputUsdScaled: rawAmountUsdScaled,
    outputAddress: outputQuotesReliable ? primaryDstToken.address : ZERO_ADDRESS,
    outputDecimals: outputQuotesReliable ? primaryDstToken.decimals : null,
    outputAmountRaw: outputQuotesReliable ? netAmountOut : null,
    outputPriceSource: outputQuotesReliable ? outputData[0]?.price.source : null,
    inputAddress: srcToken.address,
    inputDecimals: srcToken.decimals,
    inputAmountRaw: primaryEvent.amountIn,
  });
  const amountUsd = formatScaledDecimal(amountUsdScaled, USD_SCALE);
  const rawProtocolFeeUsdScaled = outputData.reduce(
    (sum, item) =>
      sum +
      calculateUsdAmountScaled(
        item.event.feeAmount,
        item.token.decimals,
        item.price.priceScaled
      ),
    0n
  );
  const protocolFeeUsdScaled =
    rawAmountUsdScaled > 0n && amountUsdScaled < rawAmountUsdScaled
      ? (rawProtocolFeeUsdScaled * amountUsdScaled) / rawAmountUsdScaled
      : rawProtocolFeeUsdScaled;
  const protocolFeeUsd = formatScaledDecimal(protocolFeeUsdScaled, USD_SCALE);
  const outputSummaries = outputData.map((item) => ({
    tokenAddress: item.token.address,
    tokenSymbol: item.token.symbol,
    tokenDecimals: item.token.decimals,
    grossAmountOut: item.event.grossAmountOut.toString(),
    netAmountOut: item.event.netAmountOut.toString(),
    feeAmount: item.event.feeAmount.toString(),
    amountUsd: formatScaledDecimal(item.amountUsdScaled, USD_SCALE),
    priceSource: item.price.source,
    priceMetadata: item.price.metadata,
    referralCode: item.event.referralCode,
    referrer: item.event.referrer,
    logIndex: item.event.logIndex,
  }));
  const metadata = {
    source: "dustswap_aggregator",
    swapMode: args.events.length > 1 ? "basket" : "single",
    aggregatorName: primaryEvent.aggregatorName || "DustSwap",
    logoURI: primaryEvent.logoURI || "logo.png",
    chainId: args.resolvedChainId,
    chainKey: args.chainConfig.key,
    chainLabel: args.chainConfig.label,
    rawAmountUsd: formatScaledDecimal(rawAmountUsdScaled, USD_SCALE),
    sanitizedAmountUsd: amountUsd,
    protocolFeeUsd,
    submittedHash: args.normalizedTxHash,
    submittedKind: args.resolvedTransaction.submittedKind,
    resolvedTxHash: args.resolvedTransaction.resolvedTxHash,
    userOperationHash: args.resolvedTransaction.userOperationHash,
    viaSmartWallet: args.resolvedTransaction.submittedKind === "user_operation",
    txFrom: txFrom || null,
    sender: primaryEvent.user,
    receiver: primaryEvent.receiver,
    routerAddress: primaryEvent.emitterAddress,
    referrer: primaryEvent.referrer,
    referralCode: primaryEvent.referralCode,
    inputTokenAddress: srcToken.address,
    outputTokenAddress: primaryDstToken.address,
    inputTokenSymbol: srcToken.symbol,
    outputTokenSymbol: primaryDstToken.symbol,
    amountIn: amountIn.toString(),
    grossAmountOut: grossAmountOut.toString(),
    netAmountOut: netAmountOut.toString(),
    feeAmount: feeAmount.toString(),
    outputs: outputSummaries,
    blockNumber: Number(receipt.blockNumber),
    transactionIndex: Number(receipt.transactionIndex),
    logIndex: primaryEvent.logIndex,
  } satisfies Record<string, unknown>;

  await upsertSwapTransaction({
    user_id: args.user.id,
    address: args.normalizedAddress,
    tx_hash: args.resolvedTransaction.resolvedTxHash,
    chain_id: args.resolvedChainId,
    router_address: primaryEvent.emitterAddress,
    sender_address: primaryEvent.user,
    src_token_address: srcToken.address,
    src_token_symbol: srcToken.symbol,
    src_token_decimals: srcToken.decimals,
    dst_token_address: primaryDstToken.address,
    dst_token_symbol: primaryDstToken.symbol,
    dst_token_decimals: primaryDstToken.decimals,
    dst_receiver: primaryEvent.receiver,
    referrer: primaryEvent.referrer,
    amount_raw: amountIn.toString(),
    spent_amount_raw: amountIn.toString(),
    return_amount_raw: netAmountOut.toString(),
    min_return_amount_raw: "0",
    guaranteed_amount_raw: netAmountOut.toString(),
    amount_usd: amountUsd,
    day_key: dayKey,
    week_key: weekKey,
    block_number: Number(receipt.blockNumber),
    block_hash: receipt.blockHash,
    transaction_index: Number(receipt.transactionIndex),
    log_index: primaryEvent.logIndex,
    occurred_at: occurredAtIso,
    metadata,
    updated_at: new Date().toISOString(),
  });

  await upsertDailyVolume(args.user.id, args.normalizedAddress, dayKey, weekKey, amountUsd);
  await upsertAlltimeVolume(args.user.id, args.normalizedAddress, occurredAtIso, amountUsd);
  await mirrorSwapToActivityEvents({
    userId: args.user.id,
    chainId: args.resolvedChainId,
    txHash: args.resolvedTransaction.resolvedTxHash,
    amountUsd,
    occurredAt: occurredAtIso,
    srcToken,
    dstToken: primaryDstToken,
    metadata,
  });
  await mirrorSwapToSweepHistory({
    userId: args.user.id,
    chainId: args.resolvedChainId,
    txHash: args.resolvedTransaction.resolvedTxHash,
    srcToken,
    dstToken: primaryDstToken,
    spentAmount: amountIn,
    returnAmount: netAmountOut,
    amountUsd,
  });

  return {
    txHash: args.resolvedTransaction.resolvedTxHash,
    amountUsd: scaledDecimalToNumber(amountUsdScaled, USD_SCALE),
    dayKey,
    weekKey,
    isNew: true,
  };
}

export async function recordSwap(input: {
  address: string;
  txHash: string;
  chainId?: number;
  trustedOpenOceanAmountUsd?: number | string | null;
}): Promise<RecordedSwap> {
  const normalizedAddress = normalizeAddress(input.address);
  const normalizedTxHash = normalizeTxHash(input.txHash);
  const resolvedChainId = resolveInputChainId(input.chainId);
  const chainConfig = getSwapChainConfig(resolvedChainId);
  const client = getPublicClientForSwapChain(resolvedChainId);

  if (!chainConfig || !client) {
    throw new ValidationError(`Unsupported swap chain: ${resolvedChainId}`);
  }

  if (!isAddress(normalizedAddress)) {
    throw new ValidationError("A valid wallet address is required");
  }

  if (!isTxHash(normalizedTxHash)) {
    throw new ValidationError("A valid transaction hash is required");
  }

  const existing = await getExistingSwap(normalizedTxHash, resolvedChainId);
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
  const resolvedTransaction = await waitForResolvedTransaction(client, normalizedTxHash as Hex);
  const existingResolvedSwap =
    resolvedTransaction.resolvedTxHash !== normalizedTxHash
      ? await getExistingSwap(resolvedTransaction.resolvedTxHash, resolvedChainId)
      : null;

  if (existingResolvedSwap) {
    return {
      txHash: existingResolvedSwap.tx_hash,
      amountUsd: Number(existingResolvedSwap.amount_usd || 0),
      dayKey: existingResolvedSwap.day_key,
      weekKey: existingResolvedSwap.week_key,
      isNew: false,
    };
  }

  const receipt = resolvedTransaction.receipt;
  if (receipt.status !== "success") {
    throw new UnprocessableSwapError("Swap transaction reverted");
  }

  const transaction = resolvedTransaction.transaction;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });

  const dustSwapAggregatorEvents = decodeDustSwapAggregatorEvents(receipt, resolvedChainId);
  if (dustSwapAggregatorEvents.length > 0) {
    return recordDustSwapAggregatorSwap({
      user,
      normalizedAddress,
      normalizedTxHash,
      resolvedChainId,
      chainConfig,
      client,
      resolvedTransaction,
      blockTimestamp: block.timestamp,
      events: dustSwapAggregatorEvents,
    });
  }

  const decodedSwap = decodeSwapEvent(receipt);
  const routingContext = await resolveSwapRoutingContext({
    expectedAddress: normalizedAddress,
    transaction,
    decodedSwap,
    resolvedTransaction,
  });
  const attributionSource = isExpectedOpenOceanReferrer(decodedSwap.referrer)
    ? "openocean_referrer"
    : routingContext.builderCodeAttributed
      ? "dustswap_builder_code"
      : null;

  if (!attributionSource) {
    throw new UnprocessableSwapError("Swap transaction was not routed through DustSwap");
  }

  const routerAddress = routingContext.routerAddress;
  const trustedOpenOceanAmountUsd = getPositiveUsdValue(input.trustedOpenOceanAmountUsd);

  const [srcToken, dstToken, openOceanDetail] = await Promise.all([
    getTokenMetadata(client, chainConfig, decodedSwap.srcToken),
    getTokenMetadata(client, chainConfig, decodedSwap.dstToken),
    trustedOpenOceanAmountUsd
      ? Promise.resolve(null)
      : fetchOpenOceanTransactionDetailWithRetry(
          chainConfig,
          resolvedTransaction.resolvedTxHash
        ),
  ]);

  const occurredAt = new Date(Number(block.timestamp) * 1000);
  const dayKey = getDayKey(occurredAt);
  const weekKey = getIsoWeekKey(occurredAt);
  const openOceanAmountUsd = getOpenOceanAmountUsd(openOceanDetail);
  const priceResult = trustedOpenOceanAmountUsd
    ? getTrustedAmountMetadata(
        chainConfig,
        resolvedTransaction.resolvedTxHash,
        trustedOpenOceanAmountUsd
      )
    : openOceanAmountUsd
      ? getOpenOceanDetailAmountMetadata(
          chainConfig,
          openOceanDetail as OpenOceanTransactionDetail,
          resolvedTransaction.resolvedTxHash,
          openOceanAmountUsd
        )
      : await (async () => {
          const outPrice = await getTokenPriceUsd(chainConfig, decodedSwap.dstToken, dayKey);
          return {
            amountUsdScaled: calculateUsdAmountScaled(
              decodedSwap.returnAmount,
              dstToken.decimals,
              outPrice.priceScaled
            ),
            source: outPrice.source,
            metadata: outPrice.metadata,
          };
        })();
  const amountUsdScaled = await sanitizeSwapUsdScaled({
    chainConfig,
    dayKey,
    outputUsdScaled: priceResult.amountUsdScaled,
    outputAddress: dstToken.address,
    outputDecimals: dstToken.decimals,
    outputAmountRaw: decodedSwap.returnAmount,
    outputPriceSource: priceResult.source,
    strictOutputVerification:
      attributionSource === "openocean_referrer" &&
      !trustedOpenOceanAmountUsd &&
      !openOceanAmountUsd,
    inputAddress: srcToken.address,
    inputDecimals: srcToken.decimals,
    inputAmountRaw: decodedSwap.spentAmount,
  });
  const amountUsd = formatScaledDecimal(amountUsdScaled, USD_SCALE);
  const protocolFeeUsd = getOpenOceanProtocolFeeUsdText(openOceanDetail);
  const occurredAtIso = occurredAt.toISOString();
  const metadata = {
    chainId: resolvedChainId,
    chainKey: chainConfig.key,
    chainLabel: chainConfig.label,
    priceSource: priceResult.source,
    priceMetadata: priceResult.metadata,
    rawAmountUsd: formatScaledDecimal(priceResult.amountUsdScaled, USD_SCALE),
    sanitizedAmountUsd: amountUsd,
    protocolFeeUsd,
    openOceanReferrerFee: openOceanDetail?.referrer_fee ?? null,
    openOceanTxProfit: openOceanDetail?.tx_profit ?? null,
    openOceanTxProfitUsd: openOceanDetail?.tx_profit_valuation ?? null,
    submittedHash: normalizedTxHash,
    submittedKind: resolvedTransaction.submittedKind,
    resolvedTxHash: resolvedTransaction.resolvedTxHash,
    userOperationHash: routingContext.userOperationHash,
    viaSmartWallet: routingContext.viaSmartWallet,
    attributionSource,
    builderCodeAttributed: routingContext.builderCodeAttributed,
    txFrom: transaction.from ? normalizeAddress(transaction.from) : null,
    sender: routingContext.senderAddress,
    routerAddress,
    referrer: decodedSwap.referrer || null,
    inputTokenAddress: srcToken.address,
    outputTokenAddress: dstToken.address,
    inputTokenSymbol: srcToken.symbol,
    outputTokenSymbol: dstToken.symbol,
    spentAmount: decodedSwap.spentAmount.toString(),
    returnAmount: decodedSwap.returnAmount.toString(),
    blockNumber: Number(receipt.blockNumber),
    transactionIndex: Number(receipt.transactionIndex),
    logIndex: decodedSwap.logIndex,
  } satisfies Record<string, unknown>;

  await upsertSwapTransaction({
    user_id: user.id,
    address: normalizedAddress,
    tx_hash: resolvedTransaction.resolvedTxHash,
    chain_id: resolvedChainId,
    router_address: routerAddress,
    sender_address: routingContext.senderAddress,
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
  });

  await upsertDailyVolume(user.id, normalizedAddress, dayKey, weekKey, amountUsd);
  await upsertAlltimeVolume(user.id, normalizedAddress, occurredAtIso, amountUsd);
  await mirrorSwapToActivityEvents({
    userId: user.id,
    chainId: resolvedChainId,
    txHash: resolvedTransaction.resolvedTxHash,
    amountUsd,
    occurredAt: occurredAtIso,
    srcToken,
    dstToken,
    metadata,
  });
  await mirrorSwapToSweepHistory({
    userId: user.id,
    chainId: resolvedChainId,
    txHash: resolvedTransaction.resolvedTxHash,
    srcToken,
    dstToken,
    spentAmount: decodedSwap.spentAmount,
    returnAmount: decodedSwap.returnAmount,
    amountUsd,
  });

  return {
    txHash: resolvedTransaction.resolvedTxHash,
    amountUsd: scaledDecimalToNumber(amountUsdScaled, USD_SCALE),
    dayKey,
    weekKey,
    isNew: true,
  };
}

export async function getUserDailyVolume(userId: number, dayKey: string): Promise<VolumeSummary> {
  const { data, error } = await postgresDb
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
  const { data, error } = await postgresDb
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
  const { data, error } = await postgresDb
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
  const { data, error, count } = await postgresDb
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

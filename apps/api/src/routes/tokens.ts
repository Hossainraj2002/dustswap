// apps/api/src/routes/tokens.ts
// Uses OnchainKit APIs: getPortfolios + buildSwapTransaction

import { Hono } from "hono";
import { getAddress, formatUnits } from "viem";

const tokens = new Hono();

// ─── Config ────────────────────────────────────────────────────────────────────

const ONCHAINKIT_BASE = "https://api.developer.coinbase.com/onchainkit/v1";
const BASE_CHAIN_ID = 8453;

// API key – loaded from env (same key used by the frontend OnchainKitProvider)
function getApiKey(): string {
  return (
    process.env.ONCHAINKIT_API_KEY ||
    process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY ||
    ""
  );
}

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Well-known stable tokens (always $1)
const STABLECOINS = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI
]);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isValidAddress(addr: string): boolean {
  try {
    getAddress(addr);
    return true;
  } catch {
    return false;
  }
}

function errorJson(message: string) {
  return { success: false, error: message, data: null };
}

function okJson<T>(data: T) {
  return { success: true, error: null, data };
}

// ─── OnchainKit API wrappers ──────────────────────────────────────────────────

interface PortfolioTokenBalance {
  address: string;
  chainId: number;
  decimals: number;
  image: string | null;
  name: string;
  symbol: string;
  cryptoBalance: number;
  fiatBalance: number;
}

interface Portfolio {
  address: string;
  tokenBalances: PortfolioTokenBalance[];
  portfolioBalanceInUsd: number;
}

/**
 * Calls OnchainKit getPortfolios to get ALL tokens a wallet holds,
 * with fiat values already included.
 */
async function getPortfolios(
  walletAddress: string
): Promise<Portfolio | null> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("ONCHAINKIT_API_KEY not configured");

  const res = await fetch(`${ONCHAINKIT_BASE}/getPortfolios`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify({
      addresses: [walletAddress],
      chains: [BASE_CHAIN_ID],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getPortfolios failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as {
    portfolios?: Portfolio[];
  };

  return json.portfolios?.[0] ?? null;
}

/**
 * Calls OnchainKit getSwapQuote for a single token pair.
 * Returns the quote with USD values and amounts.
 */
async function getSwapQuote(
  fromToken: { address: string; chainId: number; decimals: number; symbol: string; name: string; image?: string },
  toToken: { address: string; chainId: number; decimals: number; symbol: string; name: string; image?: string },
  amount: string
): Promise<{
  fromAmount: string;
  toAmount: string;
  fromAmountUSD: string;
  toAmountUSD: string;
  priceImpact: string;
  highPriceImpact: boolean;
  slippage: string;
  error?: string;
}> {
  const apiKey = getApiKey();

  const res = await fetch(`${ONCHAINKIT_BASE}/getSwapQuote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify({
      from: { ...fromToken, chainId: BASE_CHAIN_ID },
      to: { ...toToken, chainId: BASE_CHAIN_ID },
      amount,
      useAggregator: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    let errorMsg: string;
    try {
      const parsed = JSON.parse(text);
      errorMsg = parsed.error || parsed.message || `Quote failed: ${res.status}`;
    } catch {
      errorMsg = text || `Quote failed: ${res.status}`;
    }
    return {
      fromAmount: amount,
      toAmount: "0",
      fromAmountUSD: "0",
      toAmountUSD: "0",
      priceImpact: "0",
      highPriceImpact: false,
      slippage: "3",
      error: errorMsg,
    };
  }

  return (await res.json()) as {
    fromAmount: string;
    toAmount: string;
    fromAmountUSD: string;
    toAmountUSD: string;
    priceImpact: string;
    highPriceImpact: boolean;
    slippage: string;
  };
}

interface BuildSwapResponse {
  approveTransaction?: {
    to: string;
    data: string;
    gas: number;
    value: number;
    chainId: number;
  };
  transaction: {
    to: string;
    data: string;
    gas: number;
    value: number;
    chainId: number;
  };
  quote: {
    from: { address: string; symbol: string; decimals: number };
    to: { address: string; symbol: string; decimals: number };
    fromAmount: string;
    toAmount: string;
    fromAmountUSD?: string;
    toAmountUSD?: string;
    priceImpact: string;
    highPriceImpact: boolean;
    slippage: string;
  };
  fee?: {
    percentage: string;
    amount: string;
  };
  warning?: {
    type: string;
    message: string;
    description: string;
  };
  error?: string;
}

/**
 * Calls OnchainKit buildSwapTransaction to get a ready-to-sign swap tx.
 * This produces real tx data that works with the <Transaction> component.
 */
async function buildSwapTx(
  fromAddress: string,
  fromToken: { address: string; decimals: number; symbol: string; name: string; image?: string },
  toToken: { address: string; decimals: number; symbol: string; name: string; image?: string },
  amount: string
): Promise<BuildSwapResponse> {
  const apiKey = getApiKey();

  const res = await fetch(`${ONCHAINKIT_BASE}/buildSwapTransaction`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify({
      fromAddress,
      from: { ...fromToken, chainId: BASE_CHAIN_ID },
      to: { ...toToken, chainId: BASE_CHAIN_ID },
      amount,
      useAggregator: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    let errorMsg: string;
    try {
      const parsed = JSON.parse(text);
      errorMsg = parsed.error || parsed.message || `Build failed: ${res.status}`;
    } catch {
      errorMsg = text || `Build failed: ${res.status}`;
    }
    return {
      transaction: { to: "", data: "", gas: 0, value: 0, chainId: BASE_CHAIN_ID },
      quote: {
        from: { address: fromToken.address, symbol: fromToken.symbol, decimals: fromToken.decimals },
        to: { address: toToken.address, symbol: toToken.symbol, decimals: toToken.decimals },
        fromAmount: amount,
        toAmount: "0",
        priceImpact: "0",
        highPriceImpact: false,
        slippage: "3",
      },
      error: errorMsg,
    };
  }

  return (await res.json()) as BuildSwapResponse;
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── GET /api/tokens/dust?address=0x...&threshold=5 ──────────────────────────
// Uses getPortfolios to show ALL tokens with correct USD values

tokens.get("/dust", async (c) => {
  const address = c.req.query("address");
  const thresholdStr = c.req.query("threshold");

  if (!address || !isValidAddress(address)) {
    return c.json(errorJson("Missing or invalid address parameter"), 400);
  }

  const threshold = thresholdStr ? parseFloat(thresholdStr) : 5;
  if (isNaN(threshold) || threshold < 0) {
    return c.json(errorJson("threshold must be a non-negative number"), 400);
  }

  try {
    const portfolio = await getPortfolios(address);

    if (!portfolio || !portfolio.tokenBalances) {
      return c.json(
        okJson({ dustTokens: [], noLiquidityTokens: [], totalDustValueUsd: 0 })
      );
    }

    // Filter out zero balances and native ETH (address "")
    const nonZero = portfolio.tokenBalances.filter(
      (tb) => tb.cryptoBalance > 0
    );

    const dustTokens: {
      address: string;
      name: string;
      symbol: string;
      decimals: number;
      balance: string;
      balanceFormatted: string;
      usdValue: number;
      priceUsd: number;
      logoURI: string | null;
      hasLiquidity: boolean;
    }[] = [];

    const noLiquidityTokens: typeof dustTokens = [];

    for (const tb of nonZero) {
      const usdValue = tb.fiatBalance;
      const priceUsd =
        tb.cryptoBalance > 0 ? tb.fiatBalance / tb.cryptoBalance : 0;

      // Compute raw balance from cryptoBalance * 10^decimals
      const rawBalance = BigInt(
        Math.floor(tb.cryptoBalance * Math.pow(10, tb.decimals))
      ).toString();

      const entry = {
        address: tb.address || "0x0000000000000000000000000000000000000000",
        name: tb.name,
        symbol: tb.symbol,
        decimals: tb.decimals,
        balance: rawBalance,
        balanceFormatted: tb.cryptoBalance.toString(),
        usdValue: Math.round(usdValue * 10000) / 10000,
        priceUsd: priceUsd,
        logoURI: tb.image,
        hasLiquidity: usdValue > 0 || priceUsd > 0 || STABLECOINS.has(tb.address?.toLowerCase()),
      };

      // Skip tokens above threshold (they're not dust)
      if (usdValue > threshold && priceUsd > 0) continue;

      // Skip native ETH from dust (address is empty string or zero address)
      if (!tb.address || tb.address === "" || tb.symbol === "ETH") continue;

      if (entry.hasLiquidity) {
        dustTokens.push(entry);
      } else {
        noLiquidityTokens.push(entry);
      }
    }

    // Sort by USD value descending
    dustTokens.sort((a, b) => b.usdValue - a.usdValue);
    noLiquidityTokens.sort((a, b) => b.usdValue - a.usdValue);

    const totalDustValueUsd = dustTokens.reduce((s, t) => s + t.usdValue, 0);

    return c.json(
      okJson({
        address: getAddress(address),
        thresholdUsd: threshold,
        dustTokens,
        noLiquidityTokens,
        totalDustValueUsd: Math.round(totalDustValueUsd * 100) / 100,
      })
    );
  } catch (err) {
    console.error("[/api/tokens/dust] Error:", err);
    return c.json(
      errorJson(`Failed to fetch tokens: ${(err as Error).message}`),
      500
    );
  }
});

// ─── POST /api/tokens/batch-quote ────────────────────────────────────────────
// For each selected dust token, calls buildSwapTransaction to get
// ready-to-sign swap data (approval + swap tx).

tokens.post("/batch-quote", async (c) => {
  const body = await c.req.json<{
    orders?: {
      tokenIn: string;
      amountIn: string;
      decimals?: number;
      symbol?: string;
      name?: string;
    }[];
    tokenOut?: string;
    walletAddress?: string;
  }>();

  if (!body || typeof body !== "object") {
    return c.json(errorJson("Invalid JSON body"), 400);
  }

  const { orders, tokenOut, walletAddress } = body;

  if (!orders || !Array.isArray(orders) || orders.length === 0) {
    return c.json(errorJson("orders must be a non-empty array"), 400);
  }

  if (orders.length > 20) {
    return c.json(errorJson("Maximum 20 orders per batch"), 400);
  }

  // Determine output token
  let toTokenAddress = tokenOut || USDC_ADDRESS;
  let toTokenSymbol = "USDC";
  let toTokenDecimals = 6;
  let toTokenName = "USD Coin";

  if (toTokenAddress.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
    toTokenSymbol = "WETH";
    toTokenDecimals = 18;
    toTokenName = "Wrapped Ether";
  } else if (toTokenAddress.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
    toTokenSymbol = "USDC";
    toTokenDecimals = 6;
    toTokenName = "USD Coin";
  }

  const toToken = {
    address: toTokenAddress,
    decimals: toTokenDecimals,
    symbol: toTokenSymbol,
    name: toTokenName,
  };

  // We need a wallet address to build transactions
  // The frontend should send it, or we use a placeholder for quote-only mode
  const fromAddress =
    walletAddress || "0x0000000000000000000000000000000000000001";

  const results: {
    tokenIn: string;
    amountIn: string;
    success: boolean;
    error?: string;
    // Quote data
    amountOut?: string;
    estimatedAmountOut?: string;
    minAmountOut?: string;
    fromAmountUSD?: string;
    toAmountUSD?: string;
    priceImpact?: string;
    poolFee?: number;
    maxSwappablePercent?: number;
    // Transaction data (ready to sign)
    approveTransaction?: {
      to: string;
      data: string;
      gas: number;
      value: number;
    };
    swapTransaction?: {
      to: string;
      data: string;
      gas: number;
      value: number;
    };
  }[] = [];

  let totalFromUSD = 0;
  let totalToUSD = 0;
  let successCount = 0;
  let failCount = 0;

  // Process orders in batches of 3 to avoid rate limits
  const BATCH_SIZE = 3;
  for (let i = 0; i < orders.length; i += BATCH_SIZE) {
    const batch = orders.slice(i, i + BATCH_SIZE);

    const batchPromises = batch.map(async (order) => {
      const fromToken = {
        address: order.tokenIn,
        decimals: order.decimals ?? 18,
        symbol: order.symbol ?? "TOKEN",
        name: order.name ?? "Unknown Token",
      };

      try {
        // Use buildSwapTransaction — this gives us both the quote AND tx data
        const result = await buildSwapTx(
          fromAddress,
          fromToken,
          toToken,
          order.amountIn
        );

        if (result.error) {
          return {
            tokenIn: order.tokenIn,
            amountIn: order.amountIn,
            success: false,
            error: result.error,
          };
        }

        const fromUSD = parseFloat(result.quote.fromAmountUSD || "0");
        const toUSD = parseFloat(result.quote.toAmountUSD || "0");

        // Apply 5% slippage for minAmountOut
        const amountOut = BigInt(result.quote.toAmount || "0");
        const minAmountOut = (amountOut * 95n) / 100n;

        return {
          tokenIn: order.tokenIn,
          amountIn: order.amountIn,
          success: true,
          amountOut: result.quote.toAmount,
          estimatedAmountOut: result.quote.toAmount,
          minAmountOut: minAmountOut.toString(),
          fromAmountUSD: fromUSD.toFixed(4),
          toAmountUSD: toUSD.toFixed(4),
          priceImpact: result.quote.priceImpact,
          poolFee: 3000,
          maxSwappablePercent: 100,
          approveTransaction: result.approveTransaction
            ? {
                to: result.approveTransaction.to,
                data: result.approveTransaction.data,
                gas: result.approveTransaction.gas,
                value: result.approveTransaction.value,
              }
            : undefined,
          swapTransaction: {
            to: result.transaction.to,
            data: result.transaction.data,
            gas: result.transaction.gas,
            value: result.transaction.value,
          },
          _fromUSD: fromUSD,
          _toUSD: toUSD,
        };
      } catch (err) {
        return {
          tokenIn: order.tokenIn,
          amountIn: order.amountIn,
          success: false,
          error: (err as Error).message,
        };
      }
    });

    const batchResults = await Promise.all(batchPromises);

    for (const r of batchResults) {
      if (r.success) {
        successCount++;
        totalFromUSD += (r as { _fromUSD?: number })._fromUSD || 0;
        totalToUSD += (r as { _toUSD?: number })._toUSD || 0;
      } else {
        failCount++;
      }
      // Remove internal fields before adding to results
      const { _fromUSD, _toUSD, ...cleanResult } = r as typeof r & {
        _fromUSD?: number;
        _toUSD?: number;
      };
      results.push(cleanResult);
    }

    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < orders.length) {
      await sleep(200);
    }
  }

  const successfulQuotes = results.filter((r) => r.success);

  // Compute totals
  let totalAmountOut = 0n;
  for (const q of successfulQuotes) {
    totalAmountOut += BigInt(q.amountOut || "0");
  }

  // DustSwap fee: 2%
  const DUST_SWEEP_FEE_BPS = 200;
  const feeAmount = (totalAmountOut * BigInt(DUST_SWEEP_FEE_BPS)) / 10000n;
  const netOutput = totalAmountOut - feeAmount;

  let estimatedOutputFormatted = "0";
  try {
    estimatedOutputFormatted = formatUnits(netOutput, toTokenDecimals);
  } catch {
    estimatedOutputFormatted = "0";
  }

  return c.json(
    okJson({
      // Per-token quotes with tx data
      quotes: results,
      perTokenQuotes: successfulQuotes,

      // Totals
      totalAmountOut: totalAmountOut.toString(),
      netOutput: netOutput.toString(),
      estimatedOutput: netOutput.toString(),
      estimatedOutputFormatted,
      feeAmount: feeAmount.toString(),
      dustSweepFeeBps: DUST_SWEEP_FEE_BPS,

      totalDustValueUsd: Math.round(totalFromUSD * 100) / 100,
      swapFeeUsd: Math.round(totalFromUSD * 0.02 * 100) / 100,
      swapFeePercent: 2,

      outputToken: toTokenSymbol,
      outputTokenSymbol: toTokenSymbol,
      outputTokenDecimals: toTokenDecimals,

      selectedCount: successCount,

      summary: {
        orderCount: orders.length,
        successCount,
        failCount,
        totalAmountOut: totalAmountOut.toString(),
        netOutput: netOutput.toString(),
        estimatedOutput: netOutput.toString(),
        dustSweepFeeBps: DUST_SWEEP_FEE_BPS,
        feeAmount: feeAmount.toString(),
      },
    })
  );
});

// ─── GET /api/tokens/balances?address=0x... ──────────────────────────────────
// Also uses getPortfolios

tokens.get("/balances", async (c) => {
  const address = c.req.query("address");

  if (!address || !isValidAddress(address)) {
    return c.json(errorJson("Missing or invalid address parameter"), 400);
  }

  try {
    const portfolio = await getPortfolios(address);

    if (!portfolio || !portfolio.tokenBalances) {
      return c.json(okJson({ address: getAddress(address), tokenCount: 0, tokens: [] }));
    }

    const balances = portfolio.tokenBalances
      .filter((tb) => tb.cryptoBalance > 0)
      .map((tb) => ({
        tokenAddress: tb.address,
        symbol: tb.symbol,
        name: tb.name,
        decimals: tb.decimals,
        balance: BigInt(
          Math.floor(tb.cryptoBalance * Math.pow(10, tb.decimals))
        ).toString(),
        balanceFormatted: tb.cryptoBalance.toString(),
        usdValue: tb.fiatBalance,
        priceUsd: tb.cryptoBalance > 0 ? tb.fiatBalance / tb.cryptoBalance : 0,
        logoURI: tb.image,
      }));

    return c.json(
      okJson({
        address: getAddress(address),
        tokenCount: balances.length,
        tokens: balances,
      })
    );
  } catch (err) {
    console.error("[/api/tokens/balances] Error:", err);
    return c.json(
      errorJson(`Failed to fetch balances: ${(err as Error).message}`),
      500
    );
  }
});

// ─── GET /api/tokens/prices?tokens=0x...,0x... ──────────────────────────────
// Uses getSwapQuote to derive on-chain prices

tokens.get("/prices", async (c) => {
  const tokensParam = c.req.query("tokens");

  if (!tokensParam) {
    return c.json(
      errorJson("Missing required query param: tokens (comma-separated)"),
      400
    );
  }

  const tokenList = tokensParam
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokenList.length === 0) {
    return c.json(errorJson("No valid token addresses provided"), 400);
  }

  try {
    const prices: Record<string, { priceUsd: number; liquidity: number }> = {};

    // Quote each token against USDC to get a price
    for (const tokenAddr of tokenList) {
      if (!isValidAddress(tokenAddr)) continue;

      // Stablecoins
      if (STABLECOINS.has(tokenAddr.toLowerCase())) {
        prices[tokenAddr] = { priceUsd: 1.0, liquidity: 1 };
        continue;
      }

      try {
        const quote = await getSwapQuote(
          { address: tokenAddr, chainId: BASE_CHAIN_ID, decimals: 18, symbol: "TOKEN", name: "Token" },
          { address: USDC_ADDRESS, chainId: BASE_CHAIN_ID, decimals: 6, symbol: "USDC", name: "USD Coin" },
          "1000000000000000000" // 1 token (18 decimals)
        );

        if (!quote.error && quote.toAmount && quote.toAmount !== "0") {
          const priceUsd = Number(quote.toAmount) / 1e6;
          prices[tokenAddr] = { priceUsd, liquidity: priceUsd > 0 ? 1 : 0 };
        } else {
          prices[tokenAddr] = { priceUsd: 0, liquidity: 0 };
        }
      } catch {
        prices[tokenAddr] = { priceUsd: 0, liquidity: 0 };
      }

      // Small delay to avoid rate limits
      await sleep(100);
    }

    return c.json(
      okJson({
        tokenCount: Object.keys(prices).length,
        prices,
      })
    );
  } catch (err) {
    console.error("[/api/tokens/prices] Error:", err);
    return c.json(
      errorJson(`Failed to fetch prices: ${(err as Error).message}`),
      500
    );
  }
});

// ─── GET /api/tokens/quote ──────────────────────────────────────────────────
// Single swap quote using getSwapQuote

tokens.get("/quote", async (c) => {
  const tokenIn = c.req.query("tokenIn");
  const tokenOut = c.req.query("tokenOut");
  const amountIn = c.req.query("amountIn");

  if (!tokenIn || !isValidAddress(tokenIn)) {
    return c.json(errorJson("Invalid or missing tokenIn address"), 400);
  }
  if (!tokenOut || !isValidAddress(tokenOut)) {
    return c.json(errorJson("Invalid or missing tokenOut address"), 400);
  }
  if (!amountIn) {
    return c.json(errorJson("Missing amountIn"), 400);
  }

  try {
    const quote = await getSwapQuote(
      { address: tokenIn, chainId: BASE_CHAIN_ID, decimals: 18, symbol: "TOKEN", name: "Token" },
      { address: tokenOut, chainId: BASE_CHAIN_ID, decimals: 18, symbol: "TOKEN", name: "Token" },
      amountIn
    );

    return c.json(okJson(quote));
  } catch (err) {
    console.error("[/api/tokens/quote] Error:", err);
    return c.json(
      errorJson(`Failed to get quote: ${(err as Error).message}`),
      500
    );
  }
});

// ─── Health check ──────────────────────────────────────────────────────────────

tokens.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "token-discovery-onchainkit",
    chain: "base",
    chainId: 8453,
    apiKeyConfigured: !!getApiKey(),
    timestamp: new Date().toISOString(),
  });
});

export default tokens;
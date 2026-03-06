// apps/api/src/routes/tokens.ts
// Dual-strategy quoting: CDP API (V3 tokens) → 0x API fallback (V4 / Base App coins)

import { Hono } from "hono";
import { getAddress, formatUnits, parseUnits, encodeFunctionData, erc20Abi } from "viem";

const tokens = new Hono();

// ─── Config ────────────────────────────────────────────────────────────────────

const BASE_CHAIN_ID = 8453;

// CDP JSON-RPC endpoint — same one OnchainKit uses internally
function getCdpRpcUrl(): string {
  const cdpKey = process.env.CDP_API_KEY || "";
  if (cdpKey) {
    return `https://api.developer.coinbase.com/rpc/v1/base/${cdpKey}`;
  }
  const paymasterUrl =
    process.env.NEXT_PUBLIC_PAYMASTER_URL ||
    process.env.PAYMASTER_URL ||
    "";
  if (paymasterUrl) {
    const match = paymasterUrl.match(/\/rpc\/v1\/[^/]+\/([^/?]+)/);
    if (match?.[1]) {
      return `https://api.developer.coinbase.com/rpc/v1/base/${match[1]}`;
    }
  }
  const apiKey =
    process.env.ONCHAINKIT_API_KEY ||
    process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY ||
    "";
  if (!apiKey)
    throw new Error(
      "No CDP API key configured. Set CDP_API_KEY, PAYMASTER_URL, or ONCHAINKIT_API_KEY."
    );
  return `https://api.developer.coinbase.com/rpc/v1/base/${apiKey}`;
}

// CDP JSON-RPC method names
const CDP_GET_TOKEN_BALANCES = "cdp_getTokensForAddresses";
const CDP_GET_SWAP_QUOTE = "cdp_getSwapQuote";
const CDP_GET_SWAP_TRADE = "cdp_getSwapTrade";

// Token addresses
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ETH_PLACEHOLDER = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const STABLECOINS = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
]);

// ─── 0x API Config ─────────────────────────────────────────────────────────────
// The 0x aggregator supports Uniswap V4 pools on Base — perfect fallback for
// Base App coins that the CDP API can't route.

const ZEROX_API_BASE = "https://api.0x.org";

function get0xApiKey(): string {
  return process.env.ZEROX_API_KEY || "";
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── CDP JSON-RPC ──────────────────────────────────────────────────────────────

async function cdpRpc(
  method: string,
  params: unknown[]
): Promise<{
  result?: unknown;
  error?: { code: number; message: string };
}> {
  const url = getCdpRpcUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CDP RPC failed (${res.status}): ${text}`);
  }
  return (await res.json()) as {
    result?: unknown;
    error?: { code: number; message: string };
  };
}

// ─── Exact Balance Fetching (Multicall fallback) ───────────────────────────────

async function getExactTokenBalances(
  walletAddress: string,
  tokenAddresses: string[]
): Promise<Record<string, string>> {
  const url = getCdpRpcUrl();
  const balanceMap: Record<string, string> = {};

  if (tokenAddresses.length === 0) return balanceMap;

  // Batch JSON-RPC eth_call for balanceOf
  const batchReq = tokenAddresses.map((tokenAddr, idx) => {
    // encodeFunctionData for balanceOf(address)
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [walletAddress as `0x${string}`],
    });

    return {
      jsonrpc: "2.0",
      id: idx + 1,
      method: "eth_call",
      params: [
        {
          to: tokenAddr,
          data,
        },
        "latest",
      ],
    };
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batchReq),
    });

    if (res.ok) {
      const results = (await res.json()) as { id: number; result?: string; error?: any }[];
      for (const r of results) {
        if (r.result && r.result !== "0x") {
          const tokenAddr = tokenAddresses[r.id - 1].toLowerCase();
          balanceMap[tokenAddr] = BigInt(r.result).toString();
        }
      }
    }
  } catch (err) {
    console.warn("Failed to fetch exact token balances", err);
  }

  return balanceMap;
}

// ─── 0x API Swap Quote ─────────────────────────────────────────────────────────
// Used as fallback when CDP can't route (e.g. V4-only Base App coins).
// 0x aggregates across V3, V4, and other DEXs on Base.

// 0x API v2 response (allowance-holder) — transaction data is nested
interface ZeroXV2Response {
  buyAmount: string;
  sellAmount: string;
  minBuyAmount: string;
  liquidityAvailable: boolean;
  // In v2, tx details are nested inside `transaction`
  transaction: {
    to: string;
    data: string;
    value: string;
    gas: string;
    gasPrice: string;
  };
  // The spender address for token approvals
  issues?: {
    allowance?: {
      spender?: string;
    };
  };
  // Legacy flat fields (may still appear in some versions)
  allowanceTarget?: string;
  to?: string;
  data?: string;
  value?: string;
  gas?: string;
}

async function get0xSwapQuote(params: {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  takerAddress: string;
}): Promise<ZeroXV2Response> {
  const apiKey = get0xApiKey();
  if (!apiKey) {
    throw new Error("ZEROX_API_KEY not configured");
  }

  // For ETH output, 0x uses 0xEeee... placeholder
  const buyToken =
    params.buyToken.toLowerCase() === WETH_ADDRESS.toLowerCase()
      ? ETH_PLACEHOLDER
      : params.buyToken;

  // 0x API v2 uses /swap/allowance-holder/quote (v1 is deprecated, returns 404)
  const url = new URL(`${ZEROX_API_BASE}/swap/allowance-holder/quote`);
  url.searchParams.set("chainId", BASE_CHAIN_ID.toString());
  url.searchParams.set("sellToken", params.sellToken);
  url.searchParams.set("buyToken", buyToken);
  url.searchParams.set("sellAmount", params.sellAmount);
  url.searchParams.set("taker", params.takerAddress); // v2 uses "taker" not "takerAddress"
  url.searchParams.set("slippageBps", "1500"); // 15% auto slippage for low liquidity dust tokens

  const res = await fetch(url.toString(), {
    headers: {
      "0x-api-key": apiKey,
      "0x-version": "v2", // Required for the v2 endpoint
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`0x API failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  console.log(`[0x-v2] buyAmount=${json.buyAmount}, liquidityAvailable=${json.liquidityAvailable}`);

  // 0x v2 returns liquidityAvailable: false when there is no route
  if (json.liquidityAvailable === false) {
    throw new Error("0x: no liquidity available for this token pair");
  }

  return json as ZeroXV2Response;
}

// ─── Token balance types ─────────────────────────────────────────────────────

interface CdpTokenBalance {
  address: string;
  chainId: number;
  decimals: number;
  image: string | null;
  name: string;
  symbol: string;
  cryptoBalance: number;
  fiatBalance: number;
}

interface CdpPortfolio {
  address: string;
  tokenBalances: CdpTokenBalance[];
  portfolioBalanceInUsd: number;
}

// ─── Shared quote result type ──────────────────────────────────────────────────

interface QuoteResult {
  tokenIn: string;
  amountIn: string;
  success: boolean;
  error?: string;
  amountOut?: string;
  estimatedAmountOut?: string;
  minAmountOut?: string;
  fromAmountUSD?: string;
  toAmountUSD?: string;
  priceImpact?: string;
  poolFee?: number;
  maxSwappablePercent?: number;
  source?: string; // "cdp", "0x", or "uniswap"
  approveTransaction?: {
    to: string;
    data: string;
    gas: string;   // string to avoid BigInt overflow
    value: string; // string to avoid BigInt overflow
  };
  swapTransaction?: {
    to: string;
    data: string;
    gas: string;   // string to avoid BigInt overflow
    value: string; // string to avoid BigInt overflow
  };
  _fromUSD?: number;
  _toUSD?: number;
}

// ─── CDP quote helper ──────────────────────────────────────────────────────────

async function getQuoteViaCdp(
  order: { tokenIn: string; amountIn: string; decimals?: number },
  fromAddress: string,
  toTokenAddress: string
): Promise<QuoteResult> {
  const rpcResponse = await cdpRpc(CDP_GET_SWAP_TRADE, [
    {
      fromAddress,
      from: order.tokenIn,
      to: toTokenAddress,
      amount: order.amountIn,
      amountReference: "from",
    },
  ]);

  if (rpcResponse.error) {
    throw new Error(rpcResponse.error.message);
  }

  const trade = rpcResponse.result as {
    approveTx?: { to: string; data: string; gas: string; value: string };
    tx: { to: string; data: string; gas: string; value: string };
    fee?: { percentage: string; amount: string };
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
    chainId: number;
  };

  const fromUSD = parseFloat(trade.quote.fromAmountUSD || "0");
  const toUSD = parseFloat(trade.quote.toAmountUSD || "0");
  const amountOut = BigInt(trade.quote.toAmount || "0");
  const minAmountOut = (amountOut * 95n) / 100n;

  return {
    tokenIn: order.tokenIn,
    amountIn: order.amountIn,
    success: true,
    source: "cdp",
    amountOut: trade.quote.toAmount,
    estimatedAmountOut: trade.quote.toAmount,
    minAmountOut: minAmountOut.toString(),
    fromAmountUSD: fromUSD.toFixed(4),
    toAmountUSD: toUSD.toFixed(4),
    priceImpact: trade.quote.priceImpact,
    poolFee: 3000,
    maxSwappablePercent: 100,
    approveTransaction: trade.approveTx
      ? {
          to: trade.approveTx.to,
          data: trade.approveTx.data,
          gas: trade.approveTx.gas || "0",
          value: trade.approveTx.value || "0",
        }
      : undefined,
    swapTransaction: {
      to: trade.tx.to,
      data: trade.tx.data,
      gas: trade.tx.gas || "0",
      value: trade.tx.value || "0",
    },
    _fromUSD: fromUSD,
    _toUSD: toUSD,
  };
}

// ─── 0x quote helper (V4 fallback) ─────────────────────────────────────────────

async function getQuoteVia0x(
  order: { tokenIn: string; amountIn: string; decimals?: number },
  fromAddress: string,
  toTokenAddress: string
): Promise<QuoteResult> {
  const resp = await get0xSwapQuote({
    sellToken: order.tokenIn,
    buyToken: toTokenAddress,
    sellAmount: order.amountIn,
    takerAddress: fromAddress,
  });

  // v2 response: buyAmount at top level, tx details in `transaction` object
  const buyAmount = resp.buyAmount || "0";
  const amountOut = BigInt(buyAmount);
  const minBuyAmount = resp.minBuyAmount || (amountOut * 95n / 100n).toString();

  // Extract transaction data — v2 nests in `transaction`, v1 had them flat
  const tx = resp.transaction || { to: resp.to || "", data: resp.data || "", value: resp.value || "0", gas: resp.gas || "250000" };

  if (!tx.to || !tx.data) {
    throw new Error("0x response missing transaction data");
  }

  // Allowance target: v2 puts it in issues.allowance.spender, v1 in allowanceTarget
  const allowanceTarget =
    resp.issues?.allowance?.spender ||
    resp.allowanceTarget ||
    "";

  // Build approval call if 0x needs token allowance
  let approveTransaction: QuoteResult["approveTransaction"] = undefined;
  if (
    allowanceTarget &&
    allowanceTarget !== "0x0000000000000000000000000000000000000000"
  ) {
    // Approve MaxUint256 — 0x docs recommend providing enough allowance
    // for sell amount + gas. MaxUint256 is safe and avoids re-approval.
    const MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [
        allowanceTarget as `0x${string}`,
        MAX_UINT256,
      ],
    });
    approveTransaction = {
      to: order.tokenIn,
      data: approveData,
      gas: "60000",
      value: "0",
    };
  }

  return {
    tokenIn: order.tokenIn,
    amountIn: order.amountIn,
    success: true,
    source: "0x",
    amountOut: buyAmount,
    estimatedAmountOut: buyAmount,
    minAmountOut: minBuyAmount.toString(),
    fromAmountUSD: "0",
    toAmountUSD: "0",
    priceImpact: "0",
    poolFee: 3000,
    maxSwappablePercent: 100,
    approveTransaction,
    swapTransaction: {
      to: tx.to,
      data: tx.data,
      gas: tx.gas || "250000",
      value: tx.value || "0",
    },
    _fromUSD: 0,
    _toUSD: 0,
  };
}

// ─── Uniswap Trading API quote (3rd fallback) ────────────────────────────────
// Uses the Uniswap routing API which natively supports V2, V3, and V4 pools.
// This catches tokens that CDP (V3-only) and 0x both miss.

const UNISWAP_TRADE_API = "https://trade-api.gateway.uniswap.org/v1/quote";

async function getQuoteViaUniswap(
  order: { tokenIn: string; amountIn: string; decimals?: number },
  fromAddress: string,
  toTokenAddress: string
): Promise<QuoteResult> {
  // Uniswap Trading API — POST with JSON body
  const reqBody = {
    type: "EXACT_INPUT",
    tokenInChainId: BASE_CHAIN_ID,
    tokenOutChainId: BASE_CHAIN_ID,
    tokenIn: order.tokenIn,
    tokenOut: toTokenAddress,
    amount: order.amountIn,
    swapper: fromAddress,
    slippageTolerance: 0.15, // 15% auto slippage for low liquidity dust tokens
    urgency: 1.0,
  };

  const res = await fetch(UNISWAP_TRADE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(reqBody),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Uniswap API failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = await res.json() as {
    quote?: {
      output?: { amount?: string };
      input?: { amount?: string };
    };
    routing?: string;
    methodParameters?: {
      to: string;
      calldata: string;
      value: string;
    };
  };

  if (!json.methodParameters || !json.methodParameters.calldata) {
    throw new Error("Uniswap API: no method parameters in response");
  }

  const amountOut = json.quote?.output?.amount || "0";
  const minAmountOut = (BigInt(amountOut) * 95n / 100n).toString();

  // Build approval for the Universal Router
  const UNIVERSAL_ROUTER = json.methodParameters.to;
  const MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [UNIVERSAL_ROUTER as `0x${string}`, MAX_UINT256],
  });

  return {
    tokenIn: order.tokenIn,
    amountIn: order.amountIn,
    success: true,
    source: "uniswap",
    amountOut,
    estimatedAmountOut: amountOut,
    minAmountOut,
    fromAmountUSD: "0",
    toAmountUSD: "0",
    priceImpact: "0",
    poolFee: 3000,
    maxSwappablePercent: 100,
    approveTransaction: {
      to: order.tokenIn,
      data: approveData,
      gas: "60000",
      value: "0",
    },
    swapTransaction: {
      to: json.methodParameters.to,
      data: json.methodParameters.calldata,
      gas: "350000",
      value: json.methodParameters.value || "0",
    },
    _fromUSD: 0,
    _toUSD: 0,
  };
}

// ─── Content Coin Ownership Check ──────────────────────────────────────────────

const OWNERSHIP_ABI = [
  { inputs: [], name: "platformReferrer", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "owner", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "payoutRecipient", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
] as const;

async function getOwnContentCoins(
  walletAddress: string,
  tokenAddresses: string[]
): Promise<Set<string>> {
  const url = getCdpRpcUrl();
  const ownCoins = new Set<string>();
  if (tokenAddresses.length === 0) return ownCoins;

  const targetAddress = walletAddress.toLowerCase();
  const batchReq = [];
  let reqId = 1;
  const reqMap = new Map<number, string>();

  // Check all 3 possible creator/owner fields
  for (const tokenAddr of tokenAddresses) {
    const funcs = ["platformReferrer", "owner", "payoutRecipient"] as const;
    for (const func of funcs) {
      try {
        const data = encodeFunctionData({ abi: OWNERSHIP_ABI, functionName: func });
        batchReq.push({
          jsonrpc: "2.0",
          id: reqId,
          method: "eth_call",
          params: [{ to: tokenAddr, data }, "latest"],
        });
        reqMap.set(reqId, tokenAddr.toLowerCase());
        reqId++;
      } catch (e) {}
    }
  }

  // To prevent 413 Payload Too Large, split into smaller chunks if > 100 requests
  for (let i = 0; i < batchReq.length; i += 100) {
    const chunk = batchReq.slice(i, i + 100);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chunk),
      });
      if (res.ok) {
        const results = (await res.json()) as { id: number; result?: string; error?: any }[];
        for (const r of results) {
          if (r.result && r.result !== "0x" && r.result.length === 66) {
            // padded address (32 bytes)
            const addr = "0x" + r.result.slice(26).toLowerCase();
            if (addr === targetAddress) {
              const tokenAddr = reqMap.get(r.id);
              if (tokenAddr) ownCoins.add(tokenAddr);
            }
          }
        }
      }
    } catch (err) { }
  }

  return ownCoins;
}

// ─── GET /api/tokens/dust?address=0x...&threshold=5 ──────────────────────────

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
    const rpcResponse = await cdpRpc(CDP_GET_TOKEN_BALANCES, [
      { addresses: [address] },
    ]);

    if (rpcResponse.error) {
      throw new Error(
        `CDP API error: ${rpcResponse.error.message} (code: ${rpcResponse.error.code})`
      );
    }

    const result = rpcResponse.result as { portfolios?: CdpPortfolio[] };
    const portfolio = result?.portfolios?.[0];

    if (!portfolio || !portfolio.tokenBalances) {
      return c.json(
        okJson({ dustTokens: [], noLiquidityTokens: [], totalDustValueUsd: 0 })
      );
    }

    const nonZero = portfolio.tokenBalances.filter(
      (tb) => tb.cryptoBalance > 0
    );

    // Fetch EXACT raw balances from the chain to avoid floating-point truncations
    // that cause "ERC20: transfer amount exceeds balance"
    const nonZeroAddresses = nonZero
      .map((tb) => tb.address)
      .filter((addr): addr is string => !!addr && addr !== "");
      
    const exactBalances = await getExactTokenBalances(address, nonZeroAddresses);
    const ownContentCoins = await getOwnContentCoins(address, nonZeroAddresses);

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
      isOwnContentCoin: boolean;
    }[] = [];

    const noLiquidityTokens: typeof dustTokens = [];

    for (const tb of nonZero) {
      const usdValue = tb.fiatBalance;
      const priceUsd =
        tb.cryptoBalance > 0 ? tb.fiatBalance / tb.cryptoBalance : 0;

      // Fix precision bug: prioritize exact on-chain balance over CDP's float
      let rawBalance = "0";
      const tokenAddrMap = (tb.address || "").toLowerCase();
      
      if (exactBalances[tokenAddrMap]) {
        rawBalance = exactBalances[tokenAddrMap];
      } else {
        // Fallback: If cryptoBalance is already impossibly large, assume CDP returned raw Wei
        // instead of a float. Otherwise, reliably convert the float to Wei.
        if (tb.cryptoBalance > 1e15) {
          rawBalance = BigInt(Math.floor(tb.cryptoBalance)).toString();
        } else {
          try {
            const strBalance = Number(tb.cryptoBalance).toFixed(tb.decimals);
            rawBalance = parseUnits(strBalance, tb.decimals).toString();
          } catch {
            rawBalance = BigInt(
              Math.floor(tb.cryptoBalance * Math.pow(10, tb.decimals))
            ).toString();
          }
        }
      }

      const entry = {
        address: tb.address || "0x0000000000000000000000000000000000000000",
        name: tb.name,
        symbol: tb.symbol,
        decimals: tb.decimals,
        balance: rawBalance,
        balanceFormatted: formatUnits(BigInt(rawBalance), tb.decimals),
        usdValue: Math.round(usdValue * 10000) / 10000,
        priceUsd,
        logoURI: tb.image,
        hasLiquidity: true, // Mark all as having liquidity — we'll try 0x fallback
        isOwnContentCoin: ownContentCoins.has(tokenAddrMap),
      };

      if (usdValue > threshold && priceUsd > 0) continue;
      if (!tb.address || tb.address === "" || tb.symbol === "ETH") continue;

      if (!entry.isOwnContentCoin && usdValue <= threshold) {
        dustTokens.push(entry);
      } else if (entry.isOwnContentCoin) {
        dustTokens.push(entry);
      }
    }

    dustTokens.sort((a, b) => b.usdValue - a.usdValue);

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
// Triple-strategy quoting:
//   1. Try CDP API (cdp_getSwapTrade) — covers V3 tokens
//   2. If CDP fails, try 0x API — covers V4 Base App coins and other DEXs
//   3. If 0x fails, try Uniswap Trading API — native V2/V3/V4 routing

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

  if (toTokenAddress.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
    toTokenSymbol = "WETH";
    toTokenDecimals = 18;
  } else if (toTokenAddress.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
    toTokenSymbol = "USDC";
    toTokenDecimals = 6;
  }

  // For "ETH" output, use WETH address for quoting
  if (toTokenAddress === "ETH" || toTokenAddress === ETH_PLACEHOLDER) {
    toTokenAddress = WETH_ADDRESS;
    toTokenSymbol = "ETH";
    toTokenDecimals = 18;
  }

  const fromAddress =
    walletAddress || "0x0000000000000000000000000000000000000001";

  // ── PRE-FLIGHT CHECK: Mathematically guarantee we don't exceed balances ──
  // If the frontend passed a slightly inflated balance due to float rounding,
  // or if the user's balance dropped, this capping prevents "ERC20: transfer amount exceeds balance"
  if (walletAddress && isValidAddress(walletAddress)) {
    const tokenAddressesToVerify = orders.map((o) => o.tokenIn);
    const realBalances = await getExactTokenBalances(walletAddress, tokenAddressesToVerify);

    for (const order of orders) {
      const realBalStr = realBalances[order.tokenIn.toLowerCase()];
      if (realBalStr) {
        const realBal = BigInt(realBalStr);
        try {
          const requestedBal = BigInt(order.amountIn);
          if (requestedBal > realBal) {
            order.amountIn = realBal.toString();
          }
        } catch {
          // If amountIn is malformed, force it to real balance
          order.amountIn = realBal.toString();
        }
      }
    }
  }

  // Filter out any orders that dropped to 0
  const validOrders = orders.filter((o) => {
    try {
      return BigInt(o.amountIn) > 0n;
    } catch {
      return false;
    }
  });

  const results: QuoteResult[] = [];
  let totalFromUSD = 0;
  let totalToUSD = 0;
  let successCount = 0;
  let failCount = orders.length - validOrders.length; // Count 0-balance as failed

  // Process orders in batches of 3 to avoid rate limits
  const BATCH_SIZE = 3;
  for (let i = 0; i < validOrders.length; i += BATCH_SIZE) {
    const batch = validOrders.slice(i, i + BATCH_SIZE);

    const batchPromises = batch.map(async (order): Promise<QuoteResult> => {
      // ── Strategy 1: Try CDP API (V3 routing) ──────────────────────────
      try {
        const cdpResult = await getQuoteViaCdp(
          order,
          fromAddress,
          toTokenAddress
        );
        console.log(
          `[batch-quote] CDP success for ${order.tokenIn.slice(0, 10)}...`
        );
        return cdpResult;
      } catch (cdpErr) {
        console.log(
          `[batch-quote] CDP failed for ${order.tokenIn.slice(0, 10)}...: ${(cdpErr as Error).message.slice(0, 80)}`
        );
      }

      // ── Strategy 2: Try 0x API (V4 + aggregator routing) ──────────────
      try {
        const zeroXResult = await getQuoteVia0x(
          order,
          fromAddress,
          toTokenAddress
        );
        console.log(
          `[batch-quote] 0x success for ${order.tokenIn.slice(0, 10)}...`
        );
        return zeroXResult;
      } catch (zeroXErr) {
        console.log(
          `[batch-quote] 0x failed for ${order.tokenIn.slice(0, 10)}...: ${(zeroXErr as Error).message.slice(0, 80)}`
        );
      }

      // ── Strategy 3: Try Uniswap Trading API (V2/V3/V4) ────────────────
      try {
        const uniResult = await getQuoteViaUniswap(
          order,
          fromAddress,
          toTokenAddress
        );
        console.log(
          `[batch-quote] Uniswap success for ${order.tokenIn.slice(0, 10)}...`
        );
        return uniResult;
      } catch (uniErr) {
        console.log(
          `[batch-quote] Uniswap failed for ${order.tokenIn.slice(0, 10)}...: ${(uniErr as Error).message.slice(0, 120)}`
        );
      }

      // ── All strategies failed ─────────────────────────────────────────
      return {
        tokenIn: order.tokenIn,
        amountIn: order.amountIn,
        success: false,
        error: "No swap route found via CDP, 0x, or Uniswap",
      };
    });

    const batchResults = await Promise.all(batchPromises);

    for (const r of batchResults) {
      if (r.success) {
        successCount++;
        totalFromUSD += r._fromUSD || 0;
        totalToUSD += r._toUSD || 0;
      } else {
        failCount++;
      }
      // Remove internal fields before adding to results
      const { _fromUSD, _toUSD, ...cleanResult } = r;
      results.push(cleanResult);
    }

    // Small delay between batches to respect rate limits
    if (i + BATCH_SIZE < orders.length) {
      await sleep(300);
    }
  }

  const successfulQuotes = results.filter((r) => r.success);

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
      quotes: results,
      perTokenQuotes: successfulQuotes,
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

tokens.get("/balances", async (c) => {
  const address = c.req.query("address");

  if (!address || !isValidAddress(address)) {
    return c.json(errorJson("Missing or invalid address parameter"), 400);
  }

  try {
    const rpcResponse = await cdpRpc(CDP_GET_TOKEN_BALANCES, [
      { addresses: [address] },
    ]);

    if (rpcResponse.error) {
      throw new Error(`CDP API error: ${rpcResponse.error.message}`);
    }

    const result = rpcResponse.result as { portfolios?: CdpPortfolio[] };
    const portfolio = result?.portfolios?.[0];

    if (!portfolio || !portfolio.tokenBalances) {
      return c.json(
        okJson({ address: getAddress(address), tokenCount: 0, tokens: [] })
      );
    }

    const nonZero = portfolio.tokenBalances.filter(
      (tb) => tb.cryptoBalance > 0
    );

    const nonZeroAddresses = nonZero
      .map((tb) => tb.address)
      .filter((addr): addr is string => !!addr && addr !== "");
      
    const exactBalances = await getExactTokenBalances(address, nonZeroAddresses);

    const balances = nonZero.map((tb) => {
      const tokenAddrMap = (tb.address || "").toLowerCase();
      
      let rawBalance = "0";
      if (exactBalances[tokenAddrMap]) {
        rawBalance = exactBalances[tokenAddrMap];
      } else {
        try {
          rawBalance = parseUnits(tb.cryptoBalance.toFixed(tb.decimals), tb.decimals).toString();
        } catch {
          rawBalance = BigInt(Math.floor(tb.cryptoBalance * Math.pow(10, tb.decimals))).toString();
        }
      }

      return {
        tokenAddress: tb.address,
        symbol: tb.symbol,
        name: tb.name,
        decimals: tb.decimals,
        balance: rawBalance,
        balanceFormatted: tb.cryptoBalance.toString(),
        usdValue: tb.fiatBalance,
        priceUsd: tb.cryptoBalance > 0 ? tb.fiatBalance / tb.cryptoBalance : 0,
        logoURI: tb.image,
      };
    });

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

    for (const tokenAddr of tokenList) {
      if (!isValidAddress(tokenAddr)) continue;

      if (STABLECOINS.has(tokenAddr.toLowerCase())) {
        prices[tokenAddr] = { priceUsd: 1.0, liquidity: 1 };
        continue;
      }

      try {
        const rpcResponse = await cdpRpc(CDP_GET_SWAP_QUOTE, [
          {
            from: tokenAddr,
            to: USDC_ADDRESS,
            amount: "1",
            amountReference: "from",
          },
        ]);

        if (
          !rpcResponse.error &&
          rpcResponse.result &&
          typeof rpcResponse.result === "object"
        ) {
          const quote = rpcResponse.result as { toAmount?: string };
          const toAmount = parseFloat(quote.toAmount || "0");
          const priceUsd = toAmount / 1e6;
          prices[tokenAddr] = {
            priceUsd,
            liquidity: priceUsd > 0 ? 1 : 0,
          };
        } else {
          prices[tokenAddr] = { priceUsd: 0, liquidity: 0 };
        }
      } catch {
        prices[tokenAddr] = { priceUsd: 0, liquidity: 0 };
      }

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
    const rpcResponse = await cdpRpc(CDP_GET_SWAP_QUOTE, [
      {
        from: tokenIn,
        to: tokenOut,
        amount: amountIn,
        amountReference: "from",
      },
    ]);

    if (rpcResponse.error) {
      return c.json(
        errorJson(`Quote error: ${rpcResponse.error.message}`),
        404
      );
    }

    return c.json(okJson(rpcResponse.result));
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
    service: "token-discovery-dual-strategy",
    chain: "base",
    chainId: 8453,
    cdpKeyConfigured: !!(
      process.env.CDP_API_KEY ||
      process.env.NEXT_PUBLIC_PAYMASTER_URL ||
      process.env.ONCHAINKIT_API_KEY
    ),
    zeroxKeyConfigured: !!process.env.ZEROX_API_KEY,
    timestamp: new Date().toISOString(),
  });
});

export default tokens;
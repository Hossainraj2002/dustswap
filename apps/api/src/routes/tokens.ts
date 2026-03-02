// apps/api/src/routes/tokens.ts

import { Hono } from "hono";
import { validator } from "hono/validator";
import { getTokenDiscovery } from "../services/tokenDiscovery";
import { getAddress } from "viem";

const tokens = new Hono();

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isValidAddress(addr: string): boolean {
  try {
    getAddress(addr);
    return true;
  } catch {
    return false;
  }
}

function errorResponse(message: string, status: number = 400) {
  return {
    success: false,
    error: message,
    data: null,
  };
}

function successResponse<T>(data: T) {
  return {
    success: true,
    error: null,
    data,
  };
}

// ─── GET /api/tokens/balances?address=0x... ────────────────────────────────────

tokens.get(
  "/balances",
  validator("query", (value, c) => {
    const address = value["address"];
    if (!address || typeof address !== "string") {
      return c.json(errorResponse("Missing required query param: address"), 400);
    }
    if (!isValidAddress(address)) {
      return c.json(errorResponse("Invalid Ethereum address"), 400);
    }
    return { address: address as string };
  }),
  async (c) => {
    const { address } = c.req.valid("query");

    try {
      const discovery = getTokenDiscovery();
      const balances = await discovery.getTokenBalances(address);

      return c.json(
        successResponse({
          address: getAddress(address),
          tokenCount: balances.length,
          tokens: balances,
        })
      );
    } catch (err) {
      console.error("[/api/tokens/balances] Error:", err);
      return c.json(
        errorResponse(`Failed to fetch token balances: ${(err as Error).message}`, 500),
        500
      );
    }
  }
);

// ─── GET /api/tokens/prices?tokens=0x...,0x... ────────────────────────────────

tokens.get(
  "/prices",
  validator("query", (value, c) => {
    const tokensParam = value["tokens"];
    if (!tokensParam || typeof tokensParam !== "string") {
      return c.json(
        errorResponse("Missing required query param: tokens (comma-separated addresses)"),
        400
      );
    }

    const tokenList = tokensParam
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (tokenList.length === 0) {
      return c.json(errorResponse("No valid token addresses provided"), 400);
    }

    if (tokenList.length > 100) {
      return c.json(errorResponse("Maximum 100 tokens per request"), 400);
    }

    const invalid = tokenList.filter((t) => !isValidAddress(t));
    if (invalid.length > 0) {
      return c.json(
        errorResponse(`Invalid addresses: ${invalid.join(", ")}`),
        400
      );
    }

    return { tokens: tokenList };
  }),
  async (c) => {
    const { tokens: tokenList } = c.req.valid("query");

    try {
      const discovery = getTokenDiscovery();
      const prices = await discovery.getTokenPrices(tokenList);

      // Convert Map to plain object for JSON serialization
      const priceObj: Record<
        string,
        { priceUsd: number; liquidity: number }
      > = {};

      for (const [addr, price] of prices) {
        priceObj[addr] = price;
      }

      return c.json(
        successResponse({
          tokenCount: Object.keys(priceObj).length,
          prices: priceObj,
        })
      );
    } catch (err) {
      console.error("[/api/tokens/prices] Error:", err);
      return c.json(
        errorResponse(`Failed to fetch token prices: ${(err as Error).message}`, 500),
        500
      );
    }
  }
);

// ─── GET /api/tokens/dust?address=0x...&threshold=2 ───────────────────────────

tokens.get(
  "/dust",
  validator("query", (value, c) => {
    const address = value["address"];
    if (!address || typeof address !== "string") {
      return c.json(errorResponse("Missing required query param: address"), 400);
    }
    if (!isValidAddress(address)) {
      return c.json(errorResponse("Invalid Ethereum address"), 400);
    }

    const thresholdStr = value["threshold"];
    let threshold = 2.0; // default $2 threshold
    if (thresholdStr && typeof thresholdStr === "string") {
      const parsed = parseFloat(thresholdStr);
      if (isNaN(parsed) || parsed < 0) {
        return c.json(
          errorResponse("threshold must be a non-negative number"),
          400
        );
      }
      if (parsed > 10_000) {
        return c.json(
          errorResponse("threshold must be <= 10000"),
          400
        );
      }
      threshold = parsed;
    }

    return { address: address as string, threshold };
  }),
  async (c) => {
    const { address, threshold } = c.req.valid("query");

    try {
      const discovery = getTokenDiscovery();
      const analysis = await discovery.getDustTokens(address, threshold);

      return c.json(
        successResponse({
          address: getAddress(address),
          thresholdUsd: threshold,
          summary: {
            dustTokenCount: analysis.dustTokens.length,
            normalTokenCount: analysis.normalTokens.length,
            noLiquidityTokenCount: analysis.noLiquidityTokens.length,
            totalDustValueUsd:
              Math.round(analysis.totalDustValueUsd * 100) / 100,
            totalNormalValueUsd:
              Math.round(analysis.totalNormalValueUsd * 100) / 100,
          },
          dustTokens: analysis.dustTokens,
          normalTokens: analysis.normalTokens,
          noLiquidityTokens: analysis.noLiquidityTokens,
        })
      );
    } catch (err) {
      console.error("[/api/tokens/dust] Error:", err);
      return c.json(
        errorResponse(`Failed to analyze dust tokens: ${(err as Error).message}`, 500),
        500
      );
    }
  }
);

// ─── GET /api/tokens/quote?tokenIn=0x...&tokenOut=0x...&amountIn=1000000 ─────

tokens.get(
  "/quote",
  validator("query", (value, c) => {
    const { tokenIn, tokenOut, amountIn } = value as Record<string, string>;

    if (!tokenIn || !isValidAddress(tokenIn)) {
      return c.json(errorResponse("Invalid or missing tokenIn address"), 400);
    }
    if (!tokenOut || !isValidAddress(tokenOut)) {
      return c.json(errorResponse("Invalid or missing tokenOut address"), 400);
    }
    if (!amountIn) {
      return c.json(errorResponse("Missing required query param: amountIn"), 400);
    }

    // Validate amountIn is a valid positive integer string
    try {
      const val = BigInt(amountIn);
      if (val <= 0n) {
        return c.json(errorResponse("amountIn must be positive"), 400);
      }
    } catch {
      return c.json(
        errorResponse("amountIn must be a valid integer string (raw token units)"),
        400
      );
    }

    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
      return c.json(errorResponse("tokenIn and tokenOut must be different"), 400);
    }

    return {
      tokenIn: tokenIn as string,
      tokenOut: tokenOut as string,
      amountIn: amountIn as string,
    };
  }),
  async (c) => {
    const { tokenIn, tokenOut, amountIn } = c.req.valid("query");

    try {
      const discovery = getTokenDiscovery();
      const quote = await discovery.getSwapQuote(tokenIn, tokenOut, amountIn);

      return c.json(successResponse(quote));
    } catch (err) {
      console.error("[/api/tokens/quote] Error:", err);

      const message = (err as Error).message;

      // Distinguish between "no route" and unexpected errors
      if (message.includes("No route found")) {
        return c.json(
          errorResponse(`No swap route available: ${message}`, 404),
          404
        );
      }

      return c.json(
        errorResponse(`Failed to get quote: ${message}`, 500),
        500
      );
    }
  }
);

// ─── POST /api/tokens/batch-quote ──────────────────────────────────────────────

tokens.post(
  "/batch-quote",
  validator("json", (value, c) => {
    const body = value as {
      orders?: { tokenIn: string; amountIn: string }[];
      tokenOut?: string;
    };

    if (!body || typeof body !== "object") {
      return c.json(errorResponse("Invalid JSON body"), 400);
    }

    const { orders, tokenOut } = body;

    if (!tokenOut || !isValidAddress(tokenOut)) {
      return c.json(errorResponse("Invalid or missing tokenOut address"), 400);
    }

    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return c.json(
        errorResponse("orders must be a non-empty array"),
        400
      );
    }

    if (orders.length > 20) {
      return c.json(
        errorResponse("Maximum 20 orders per batch (matching contract MAX_BATCH_SIZE)"),
        400
      );
    }

    // Validate each order
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      if (!order || typeof order !== "object") {
        return c.json(errorResponse(`orders[${i}] is invalid`), 400);
      }
      if (!order.tokenIn || !isValidAddress(order.tokenIn)) {
        return c.json(
          errorResponse(`orders[${i}].tokenIn is invalid or missing`),
          400
        );
      }
      if (!order.amountIn) {
        return c.json(
          errorResponse(`orders[${i}].amountIn is missing`),
          400
        );
      }
      try {
        const val = BigInt(order.amountIn);
        if (val <= 0n) {
          return c.json(
            errorResponse(`orders[${i}].amountIn must be positive`),
            400
          );
        }
      } catch {
        return c.json(
          errorResponse(
            `orders[${i}].amountIn must be a valid integer string`
          ),
          400
        );
      }
      if (order.tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
        return c.json(
          errorResponse(
            `orders[${i}].tokenIn cannot be the same as tokenOut`
          ),
          400
        );
      }
    }

    return {
      orders: orders as { tokenIn: string; amountIn: string }[],
      tokenOut: tokenOut as string,
    };
  }),
  async (c) => {
    const { orders, tokenOut } = c.req.valid("json");

    try {
      const discovery = getTokenDiscovery();
      const result = await discovery.getBatchQuotes(orders, tokenOut);

      return c.json(
        successResponse({
          ...result,
          summary: {
            orderCount: orders.length,
            successCount: result.successCount,
            failCount: result.failCount,
            totalAmountOut: result.totalAmountOut,
            dustSweepFeeBps: result.dustSweepFeeBps,
            dustSweepFeePercent: `${result.dustSweepFeeBps / 100}%`,
            feeAmount: result.feeAmount,
            netOutput: result.netOutput,
          },
        })
      );
    } catch (err) {
      console.error("[/api/tokens/batch-quote] Error:", err);
      return c.json(
        errorResponse(
          `Failed to get batch quotes: ${(err as Error).message}`,
          500
        ),
        500
      );
    }
  }
);

// ─── Health check ──────────────────────────────────────────────────────────────

tokens.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "token-discovery",
    chain: "base",
    chainId: 8453,
    timestamp: new Date().toISOString(),
  });
});

export default tokens;
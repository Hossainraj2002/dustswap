import { NextRequest, NextResponse } from 'next/server';
import {
  createPublicClient,
  http,
  formatUnits,
  encodeFunctionData,
  decodeFunctionResult,
  type Address,
} from 'viem';
import { base } from 'viem/chains';

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC_URL = process.env.ALCHEMY_API_KEY
  ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org';

const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL, { timeout: 20_000 }),
});

const QUOTER_ADDRESS: Address = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const WETH_ADDRESS:   Address = '0x4200000000000000000000000000000000000006';
const USDC_ADDRESS:   Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const DUSTSWAP_FEE_BPS = 200;   // 2%
const SLIPPAGE_BPS     = 500;   // 5% — higher for dust tokens which are volatile

const FEE_TIERS = [500, 3000, 10000, 100] as const;

const QUOTER_ABI = [
  {
    inputs: [{ components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'fee', type: 'uint24' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ], name: 'params', type: 'tuple' }],
    name: 'quoteExactInputSingle',
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// ─── Quoter helpers ───────────────────────────────────────────────────────────

async function tryQuote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number,
): Promise<bigint | null> {
  try {
    const data = encodeFunctionData({
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    });
    const result = await publicClient.call({ to: QUOTER_ADDRESS, data });
    if (!result.data) return null;
    const decoded = decodeFunctionResult({
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      data: result.data,
    });
    const out = decoded[0];
    return out > 0n ? out : null;
  } catch {
    return null;
  }
}

/** Get the best direct quote across all fee tiers */
async function getBestDirectQuote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<{ amountOut: bigint; fee: number } | null> {
  let best: { amountOut: bigint; fee: number } | null = null;
  for (const fee of FEE_TIERS) {
    const out = await tryQuote(tokenIn, tokenOut, amountIn, fee);
    if (out !== null && (!best || out > best.amountOut)) {
      best = { amountOut: out, fee };
    }
  }
  return best;
}

/** Quote with WETH routing fallback */
async function getBestQuoteWithRouting(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<{ amountOut: bigint; fee: number } | null> {
  const direct = await getBestDirectQuote(tokenIn, tokenOut, amountIn);
  if (direct) return direct;

  // Two-hop via WETH (skip if tokenOut already is WETH)
  if (tokenOut.toLowerCase() === WETH_ADDRESS.toLowerCase()) return null;

  for (const fee1 of FEE_TIERS) {
    const wethOut = await tryQuote(tokenIn, WETH_ADDRESS, amountIn, fee1);
    if (!wethOut || wethOut === 0n) continue;

    const leg2 = await getBestDirectQuote(WETH_ADDRESS, tokenOut, wethOut);
    if (leg2) return { amountOut: leg2.amountOut, fee: fee1 };
  }

  return null;
}

/**
 * FIX 2 — Smart liquidity detection: tries 100% → 50% → 25% → 10% of the amount.
 * Returns the best quote found and what percentage of the balance was swappable.
 */
async function getBestQuoteWithPartialFallback(
  tokenIn: Address,
  tokenOut: Address,
  fullAmount: bigint,
): Promise<{
  amountIn: bigint;
  amountOut: bigint;
  fee: number;
  maxSwappablePercent: number;
} | null> {
  const percentages = [100, 50, 25, 10] as const;

  for (const pct of percentages) {
    const adjustedAmount = (fullAmount * BigInt(pct)) / 100n;
    if (adjustedAmount === 0n) continue;

    const result = await getBestQuoteWithRouting(tokenIn, tokenOut, adjustedAmount);
    if (result) {
      return {
        amountIn: adjustedAmount,
        amountOut: result.amountOut,
        fee: result.fee,
        maxSwappablePercent: pct,
      };
    }
  }

  return null; // truly no liquidity at any amount
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      // Frontend sends: { orders: [{tokenIn, amountIn, decimals?}], tokenOut }
      orders?: { tokenIn: string; amountIn: string; decimals?: number }[];
      tokenOut?: string;
      // Legacy format from old route (kept for backwards compat)
      tokens?: { address: string; balance: string; decimals?: number }[];
      outputToken?: string;
      outputTokenAddress?: string;
    };

    // ── Parse request — accept both frontend formats ──────────────────────

    // New format: { orders, tokenOut }
    let tokenOutAddr: Address;
    let orders: { tokenIn: Address; amountIn: bigint; decimals: number }[] = [];

    if (body.orders && body.tokenOut) {
      tokenOutAddr = body.tokenOut as Address;
      orders = body.orders.map((o) => ({
        tokenIn: o.tokenIn as Address,
        amountIn: BigInt(o.amountIn),
        decimals: o.decimals ?? 18,
      }));
    } else if (body.tokens && (body.outputTokenAddress || body.outputToken)) {
      // Old format: { tokens, outputToken, outputTokenAddress }
      if (body.outputToken === 'ETH' || !body.outputTokenAddress) {
        tokenOutAddr = WETH_ADDRESS;
      } else if (body.outputToken === 'USDC') {
        tokenOutAddr = USDC_ADDRESS;
      } else {
        tokenOutAddr = body.outputTokenAddress as Address;
      }
      orders = (body.tokens ?? []).map((t) => ({
        tokenIn: t.address as Address,
        amountIn: BigInt(t.balance),
        decimals: t.decimals ?? 18,
      }));
    } else {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    if (orders.length === 0) {
      return NextResponse.json({ error: 'No tokens provided' }, { status: 400 });
    }

    // Determine output token metadata
    const isETH = tokenOutAddr.toLowerCase() === WETH_ADDRESS.toLowerCase();
    const isUSDC = tokenOutAddr.toLowerCase() === USDC_ADDRESS.toLowerCase();
    const outputDecimals = isUSDC ? 6 : 18;
    const outputSymbol = isETH ? 'ETH' : isUSDC ? 'USDC' : 'TOKEN';

    // ── Get quotes for each token in parallel ──────────────────────────────

    const quoteResults = await Promise.all(
      orders.map(async (order) => {
        // Skip if this token IS the output token
        if (order.tokenIn.toLowerCase() === tokenOutAddr.toLowerCase()) {
          return null;
        }
        if (order.amountIn === 0n) return null;

        // FIX 2: try partial amounts if full amount has no liquidity
        const result = await getBestQuoteWithPartialFallback(
          order.tokenIn,
          tokenOutAddr,
          order.amountIn,
        );

        if (!result) return null;

        // 5% slippage for dust tokens (they can be volatile)
        const minAmountOut = (result.amountOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

        return {
          tokenIn: order.tokenIn,
          amountIn: result.amountIn.toString(),           // may be < full balance if partial
          poolFee: result.fee,
          amountOut: result.amountOut.toString(),
          estimatedAmountOut: result.amountOut.toString(), // alias for frontend
          minAmountOut: minAmountOut.toString(),
          maxSwappablePercent: result.maxSwappablePercent,
          success: true,
        };
      }),
    );

    const successfulQuotes = quoteResults.filter(
      (q): q is NonNullable<typeof q> => q !== null && q.success,
    );

    if (successfulQuotes.length === 0) {
      return NextResponse.json(
        { error: 'No valid quotes available for the selected tokens' },
        { status: 400 },
      );
    }

    // ── Aggregate totals ───────────────────────────────────────────────────

    let totalAmountOut = 0n;
    for (const q of successfulQuotes) {
      totalAmountOut += BigInt(q.amountOut);
    }

    const feeAmount  = (totalAmountOut * BigInt(DUSTSWAP_FEE_BPS)) / 10000n;
    const netOutput  = totalAmountOut - feeAmount;

    // ── Fetch USD prices for display (best-effort, doesn't block quotes) ──

    let totalDustValueUsd = 0;
    try {
      const addrList = orders.map((o) => o.tokenIn.toLowerCase()).join(',');
      const priceResp = await Promise.race([
        fetch(`https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${addrList}&vs_currencies=usd`),
        new Promise<null>((res) => setTimeout(() => res(null), 4000)),
      ]);
      if (priceResp && 'ok' in priceResp && priceResp.ok) {
        const priceData = (await priceResp.json()) as Record<string, { usd?: number }>;
        for (const q of successfulQuotes) {
          const pInfo = priceData[q.tokenIn.toLowerCase()];
          if (pInfo?.usd) {
            const order = orders.find((o) => o.tokenIn.toLowerCase() === q.tokenIn.toLowerCase());
            if (order) {
              totalDustValueUsd += Number(formatUnits(BigInt(q.amountIn), order.decimals)) * pInfo.usd;
            }
          }
        }
      }
    } catch { /* prices are display-only */ }

    const swapFeeUsd = (totalDustValueUsd * DUSTSWAP_FEE_BPS) / 10000;

    // ── Build response compatible with both frontend formats ───────────────
    // Frontend useDustSweep.getQuote() looks for:
    //   json.data.quotes  OR  json.perTokenQuotes
    //   summary.totalAmountOut, summary.netOutput, summary.estimatedOutput

    const responsePayload = {
      // Flat format (what the frontend's flexible parser can read)
      perTokenQuotes: successfulQuotes,
      quotes: successfulQuotes,
      totalAmountOut: totalAmountOut.toString(),
      netOutput: netOutput.toString(),
      estimatedOutput: netOutput.toString(),
      estimatedOutputFormatted: formatUnits(netOutput, outputDecimals),
      feeAmount: feeAmount.toString(),
      dustSweepFeeBps: DUSTSWAP_FEE_BPS,
      selectedCount: successfulQuotes.length,
      totalDustValueUsd: Math.round(totalDustValueUsd * 100) / 100,
      swapFeeUsd: Math.round(swapFeeUsd * 100) / 100,
      swapFeePercent: DUSTSWAP_FEE_BPS / 100,
      outputToken: outputSymbol,
      outputTokenSymbol: outputSymbol,
      outputTokenDecimals: outputDecimals,
      // Summary sub-object (Railway backend compat)
      summary: {
        orderCount: orders.length,
        successCount: successfulQuotes.length,
        failCount: orders.length - successfulQuotes.length,
        totalAmountOut: totalAmountOut.toString(),
        netOutput: netOutput.toString(),
        estimatedOutput: netOutput.toString(),
        dustSweepFeeBps: DUSTSWAP_FEE_BPS,
        feeAmount: feeAmount.toString(),
      },
    };

    return NextResponse.json(responsePayload);
  } catch (err) {
    console.error('[batch-quote/route] Error:', err);
    return NextResponse.json(
      { error: 'Failed to get quotes', message: String(err) },
      { status: 500 },
    );
  }
}

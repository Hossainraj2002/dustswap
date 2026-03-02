import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http, type Address, encodeFunctionData, decodeFunctionResult, formatUnits } from 'viem';
import { base } from 'viem/chains';

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org';

const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

// Uniswap V3 Quoter V2 on Base
const QUOTER_ADDRESS: Address = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const WETH_ADDRESS: Address = '0x4200000000000000000000000000000000000006';
const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const FEE_PERCENT = 2; // 2% DustSwap fee
const SLIPPAGE_BPS = 300; // 3% slippage

// Uniswap V3 QuoterV2 ABI (just what we need)
const QUOTER_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        name: 'params',
        type: 'tuple',
      },
    ],
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

// Common Uniswap V3 fee tiers
const FEE_TIERS = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

// ─── Types ───────────────────────────────────────────────────────────────────

interface TokenInput {
  address: Address;
  balance: string;
  decimals: number;
}

interface PerTokenQuote {
  tokenIn: Address;
  amountIn: string;
  poolFee: number;
  estimatedAmountOut: string;
  minAmountOut: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getBestQuote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<{ amountOut: bigint; fee: number } | null> {
  let bestAmountOut = 0n;
  let bestFee = 0;

  for (const fee of FEE_TIERS) {
    try {
      const data = encodeFunctionData({
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn,
            tokenOut,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });

      const result = await publicClient.call({
        to: QUOTER_ADDRESS,
        data,
      });

      if (result.data) {
        const decoded = decodeFunctionResult({
          abi: QUOTER_ABI,
          functionName: 'quoteExactInputSingle',
          data: result.data,
        });

        const amountOut = decoded[0];
        if (amountOut > bestAmountOut) {
          bestAmountOut = amountOut;
          bestFee = fee;
        }
      }
    } catch {
      // This fee tier doesn't have a pool, skip
      continue;
    }
  }

  if (bestAmountOut === 0n) return null;
  return { amountOut: bestAmountOut, fee: bestFee };
}

// For tokens that don't have direct pair with output,
// route through WETH as intermediate
async function getQuoteWithRouting(
  tokenIn: Address,
  finalTokenOut: Address,
  amountIn: bigint
): Promise<{ amountOut: bigint; fee: number } | null> {
  // Try direct first
  const direct = await getBestQuote(tokenIn, finalTokenOut, amountIn);
  if (direct) return direct;

  // If output is WETH, no intermediate routing possible
  if (finalTokenOut.toLowerCase() === WETH_ADDRESS.toLowerCase()) return null;

  // Route through WETH: tokenIn -> WETH -> tokenOut
  try {
    const leg1 = await getBestQuote(tokenIn, WETH_ADDRESS, amountIn);
    if (!leg1) return null;

    const leg2 = await getBestQuote(WETH_ADDRESS, finalTokenOut, leg1.amountOut);
    if (!leg2) return null;

    // Return the final output with the first leg's fee (for the main swap order)
    return { amountOut: leg2.amountOut, fee: leg1.fee };
  } catch {
    return null;
  }
}

// ─── Route Handler ───────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { tokens, outputToken, outputTokenAddress } = body as {
      tokens: TokenInput[];
      outputToken: string;
      outputTokenAddress: Address | null;
    };

    if (!tokens || tokens.length === 0) {
      return NextResponse.json(
        { error: 'No tokens provided' },
        { status: 400 }
      );
    }

    // Determine the actual output token address
    let tokenOut: Address;
    let outputDecimals: number;
    let outputSymbol: string;

    if (outputToken === 'ETH' || !outputTokenAddress) {
      tokenOut = WETH_ADDRESS; // Quote against WETH, contract unwraps
      outputDecimals = 18;
      outputSymbol = 'ETH';
    } else if (outputToken === 'USDC') {
      tokenOut = USDC_ADDRESS;
      outputDecimals = 6;
      outputSymbol = 'USDC';
    } else {
      tokenOut = outputTokenAddress;
      outputDecimals = 18;
      outputSymbol = outputToken;
    }

    // Get quotes for each token
    const perTokenQuotes: PerTokenQuote[] = [];
    let totalOutputAmount = 0n;
    let totalDustValueUsd = 0;

    // Fetch USD prices for tokens to calculate dust value
    const tokenAddresses = tokens.map(t => t.address.toLowerCase()).join(',');
    let prices: Record<string, number> = {};

    try {
      const priceResponse = await fetch(
        `https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${tokenAddresses}&vs_currencies=usd`
      );
      if (priceResponse.ok) {
        prices = await priceResponse.json();
      }
    } catch {
      // Prices are nice-to-have for the quote display
    }

    for (const token of tokens) {
      const amountIn = BigInt(token.balance);

      // Skip if balance is 0
      if (amountIn === 0n) continue;

      // Skip if token is the output token
      if (token.address.toLowerCase() === tokenOut.toLowerCase()) continue;

      try {
        const quoteResult = await getQuoteWithRouting(
          token.address,
          tokenOut,
          amountIn
        );

        if (!quoteResult) {
          console.warn(`No quote available for ${token.address}`);
          continue;
        }

        // Apply slippage to get minAmountOut
        const minAmountOut =
          (quoteResult.amountOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

        perTokenQuotes.push({
          tokenIn: token.address,
          amountIn: amountIn.toString(),
          poolFee: quoteResult.fee,
          estimatedAmountOut: quoteResult.amountOut.toString(),
          minAmountOut: minAmountOut.toString(),
        });

        totalOutputAmount += quoteResult.amountOut;

        // Calculate USD value
        const addrLower = token.address.toLowerCase();
        const priceData = prices[addrLower] as { usd?: number } | undefined;
        if (priceData?.usd) {
          const formatted = Number(formatUnits(amountIn, token.decimals));
          totalDustValueUsd += formatted * priceData.usd;
        }
      } catch (err) {
        console.error(`Quote failed for ${token.address}:`, err);
        continue;
      }
    }

    if (perTokenQuotes.length === 0) {
      return NextResponse.json(
        { error: 'No valid quotes available for selected tokens' },
        { status: 400 }
      );
    }

    // Calculate fee
    const feeAmount = (totalOutputAmount * BigInt(FEE_PERCENT)) / 100n;
    const netOutput = totalOutputAmount - feeAmount;
    const swapFeeUsd = (totalDustValueUsd * FEE_PERCENT) / 100;

    return NextResponse.json({
      selectedCount: perTokenQuotes.length,
      totalDustValueUsd: Math.round(totalDustValueUsd * 100) / 100,
      swapFeeUsd: Math.round(swapFeeUsd * 100) / 100,
      swapFeePercent: FEE_PERCENT,
      estimatedOutput: netOutput.toString(),
      estimatedOutputFormatted: formatUnits(netOutput, outputDecimals),
      outputToken,
      outputTokenSymbol: outputSymbol,
      outputTokenDecimals: outputDecimals,
      perTokenQuotes,
    });
  } catch (err) {
    console.error('Batch quote error:', err);
    return NextResponse.json(
      { error: 'Failed to get quotes', message: String(err) },
      { status: 500 }
    );
  }
}
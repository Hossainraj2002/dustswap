import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbi, parseUnits, formatUnits } from "viem";
import { base } from "viem/chains";

const V3_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const V4_QUOTER = "0x0d5e0f971ed27fbff6c2837bf31316121532048d";

const client = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_PAYMASTER_URL || "https://mainnet.base.org"),
});

const V3_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// Example realistic V4 ABI. May need adjustment if V4 Quoter format differs in production.
const V4_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactSingle(QuoteExactSingleParams memory params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const V3_FEE_TIERS = [500, 3000, 10000];

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const tokenIn = searchParams.get("tokenIn");
    const tokenOut = searchParams.get("tokenOut");
    const amountInStr = searchParams.get("amountIn");
    const decimalsIn = Number(searchParams.get("decimalsIn") || 18);
    const decimalsOut = Number(searchParams.get("decimalsOut") || 18);

    if (!tokenIn || !tokenOut || !amountInStr) {
      return NextResponse.json({ error: "Missing required parameters" }, { status: 400 });
    }

    const amountIn = parseUnits(amountInStr, decimalsIn);

    const isNativeIn = tokenIn.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const isNativeOut = tokenOut.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const WETH = "0x4200000000000000000000000000000000000006";

    const V3TokenIn = isNativeIn ? WETH : tokenIn;
    const V3TokenOut = isNativeOut ? WETH : tokenOut;

    // 1. Quote V3 (parallel tiers)
    let bestV3Quote: any = null;
    let bestV3AmountOut = BigInt(0);

    const v3Promises = V3_FEE_TIERS.map(async (fee) => {
      try {
        const result = await client.readContract({
          address: V3_QUOTER,
          abi: V3_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn: V3TokenIn as `0x${string}`,
              tokenOut: V3TokenOut as `0x${string}`,
              amountIn,
              fee,
              sqrtPriceLimitX96: BigInt(0),
            },
          ],
        });
        return { fee, result };
      } catch (e) {
        return null;
      }
    });

    const v3Results = await Promise.all(v3Promises);
    for (const res of v3Results) {
      if (res && res.result[0] > bestV3AmountOut) {
        bestV3AmountOut = res.result[0];
        bestV3Quote = {
          amountOut: res.result[0],
          fee: res.fee,
          gasEstimate: res.result[3],
        };
      }
    }

    // 2. Quote V4
    let v4Quote: any = null;
    try {
      const zeroForOne = V3TokenIn.toLowerCase() < V3TokenOut.toLowerCase();
      const currency0 = zeroForOne ? V3TokenIn : V3TokenOut;
      const currency1 = zeroForOne ? V3TokenOut : V3TokenIn;
      // standard fee and tick spacing for testing v4 quote
      const poolKey = {
        currency0: currency0 as `0x${string}`,
        currency1: currency1 as `0x${string}`,
        fee: 3000,
        tickSpacing: 60,
        hooks: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      };

      const result = await client.readContract({
        address: V4_QUOTER,
        abi: V4_ABI,
        functionName: "quoteExactSingle",
        args: [
          {
            poolKey,
            zeroForOne,
            exactAmount: amountIn,
            hookData: "0x",
          },
        ],
      });
      v4Quote = {
        amountOut: result[0],
        fee: poolKey.fee,
        gasEstimate: result[3],
      };
    } catch (e) {
      // V4 fetch failed, which is okay, fallback to V3
    }

    if (!bestV3Quote && !v4Quote) {
      return NextResponse.json({ error: "No route found" }, { status: 404 });
    }

    const useV4 = v4Quote && (!bestV3Quote || v4Quote.amountOut > bestV3Quote.amountOut);
    const bestQuote = useV4 ? v4Quote : bestV3Quote;
    const route = useV4 ? "v4" : "v3";

    // 3. Deduct 0.2% protocol fee
    const protocolFeeBps = BigInt(20);
    const amountOutAfterFee = bestQuote.amountOut - ((bestQuote.amountOut * protocolFeeBps) / BigInt(10000));

    // Simulated execution price for display
    const executionPrice =
      Number(formatUnits(amountOutAfterFee, decimalsOut)) /
      Number(formatUnits(amountIn, decimalsIn));

    // Simulated price impact (in production usually retrieved from pool sqrtPrice)
    const priceImpact = 0.12;

    return NextResponse.json({
      amountOut: formatUnits(amountOutAfterFee, decimalsOut),
      amountOutRaw: amountOutAfterFee.toString(),
      priceImpact,
      poolFee: bestQuote.fee,
      protocolFee: Number(protocolFeeBps),
      route,
      executionPrice: executionPrice.toString(),
      gasEstimate: bestQuote.gasEstimate ? bestQuote.gasEstimate.toString() : "150000",
    });
  } catch (error: any) {
    console.error("Quote API Error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}

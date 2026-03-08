"use client";

import { useState } from "react";
import { useAccount, useBalance } from "wagmi";
import { useUniswapX } from "@/hooks/useUniswapX";
import { parseUnits } from "viem";

const TOKENS = [
  { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
];

export function UniswapXSwap() {
  const { address } = useAccount();
  const { signAndSubmitOrder, isSignLoading, error } = useUniswapX();

  const [tokenIn, setTokenIn] = useState(TOKENS[0]);
  const [tokenOut, setTokenOut] = useState(TOKENS[1]);
  const [amountIn, setAmountIn] = useState("");
  const [recentSearches, setRecentSearches] = useState(["USDC", "WETH", "DEGEN"]);
  
  const { data: balanceIn } = useBalance({
    address,
    token: tokenIn.address as `0x${string}`,
  });

  // Simulated quote output (in production fetch from Uniswap routing API /quote)
  const simulatedQuoteOut = amountIn 
    ? parseUnits((Number(amountIn) * (tokenIn.symbol === "WETH" ? 3300 : 1/3300)).toString(), tokenOut.decimals).toString()
    : "0";

  const handleSwap = async () => {
    if (!amountIn) return;
    const rawAmountIn = parseUnits(amountIn, tokenIn.decimals).toString();

    await signAndSubmitOrder({
      inputToken: tokenIn.address,
      outputToken: tokenOut.address,
      amountIn: rawAmountIn,
      quoteOut: simulatedQuoteOut, // Mock logic, ideally from Unified API
    });
  };

  return (
    <div className="max-w-[400px] w-full mx-auto bg-[#0d111c] text-white p-4 rounded-3xl font-sans border border-[#1b2236]">
      <h2 className="text-xl font-semibold mb-4 text-center">Swap (UniswapX)</h2>

      <div className="bg-[#131a2a] p-4 rounded-2xl mb-1 relative">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-gray-400">Sell</span>
          <span className="text-sm text-gray-400">
            Bal: {balanceIn ? Number(balanceIn.formatted).toFixed(4) : "0.00"}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <input
            type="number"
            value={amountIn}
            onChange={(e) => setAmountIn(e.target.value)}
            placeholder="0"
            className="bg-transparent outline-none text-3xl max-w-[50%]"
          />
          <button className="bg-[#1b2236] text-white px-3 py-1.5 rounded-2xl flex items-center font-semibold">
            {tokenIn.symbol} ▼
          </button>
        </div>
      </div>

      <div className="flex justify-center -my-3 relative z-10">
        <button 
          className="bg-[#1b2236] p-2 rounded-xl text-white hover:bg-[#293249]"
          onClick={() => { setTokenIn(tokenOut); setTokenOut(tokenIn); setAmountIn("") }}
        >
          ↓
        </button>
      </div>

      <div className="bg-[#131a2a] p-4 rounded-2xl mt-1 mb-4">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-gray-400">Buy</span>
        </div>
        <div className="flex justify-between items-center">
          <input
            type="text"
            readOnly
            value={simulatedQuoteOut !== "0" ? Number(formatUnits(BigInt(simulatedQuoteOut), tokenOut.decimals)).toFixed(4) : "0"}
            className="bg-transparent outline-none text-3xl max-w-[50%] text-gray-400"
          />
          <button className="bg-[#1b2236] text-white px-3 py-1.5 rounded-2xl flex items-center font-semibold">
            {tokenOut.symbol} ▼
          </button>
        </div>
      </div>

      <button
        onClick={handleSwap}
        disabled={isSignLoading || !amountIn}
        className="w-full bg-[#3b82f6] text-white text-lg font-semibold py-3.5 rounded-2xl disabled:bg-[#1b2236] disabled:text-gray-500 hover:opacity-90 transition-all font-syne"
      >
        {isSignLoading ? "Signing Off-Chain Order..." : "Sign UniswapX Swap"}
      </button>

      {error && (
        <div className="mt-4 p-3 bg-red-500/20 text-red-500 rounded-xl text-sm break-words whitespace-pre-wrap">
          {error}
        </div>
      )}

      {/* Explore & Trending Panel */}
      <div className="mt-8 border border-[#1b2236] rounded-2xl p-4">
        <div className="mb-4">
          <h3 className="text-gray-400 text-sm mb-2">Recent Searches</h3>
          <div className="flex gap-2">
            {recentSearches.map(s => (
              <span key={s} className="bg-[#1b2236] px-3 py-1 rounded-full text-sm">{s}</span>
            ))}
          </div>
        </div>
        <div>
          <h3 className="text-gray-400 text-sm mb-2">Trending on Base</h3>
          <div className="flex justify-between items-center py-2 border-t border-[#1b2236]">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center font-bold text-xs">AERO</div>
              <div>
                <div className="font-semibold">Aerodrome</div>
                <div className="text-xs text-gray-400">AERO</div>
              </div>
            </div>
            <div className="text-right">
              <div>$1.15</div>
              <div className="text-green-500 text-xs">+12.5%</div>
            </div>
          </div>
          <div className="flex justify-between items-center py-2 border-t border-[#1b2236]">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-purple-500 flex items-center justify-center font-bold text-xs">DEGEN</div>
              <div>
                <div className="font-semibold">Degen</div>
                <div className="text-xs text-gray-400">DEGEN</div>
              </div>
            </div>
            <div className="text-right">
              <div>$0.02</div>
              <div className="text-green-500 text-xs">+45.2%</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper formatting locally
function formatUnits(value: bigint, decimals: number) {
  const s = value.toString();
  if (s.length <= decimals) {
    return "0." + s.padStart(decimals, "0");
  }
  return s.slice(0, -decimals) + "." + s.slice(-decimals);
}

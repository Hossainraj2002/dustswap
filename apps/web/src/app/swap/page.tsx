"use client";

import { useState, useEffect } from "react";
import { useAccount, useBalance } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { useSwap } from "@/hooks/useSwap";

type Token = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI: string;
};

const TOKENS: Token[] = [
  {
    address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    logoURI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  },
  {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    logoURI: "https://basescan.org/token/images/weth_28.png",
  },
  {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logoURI: "https://basescan.org/token/images/centre-usdc_28.png",
  },
  {
    address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
    logoURI: "https://basescan.org/token/images/mcdDai_32.png",
  },
  {
    address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    symbol: "cbETH",
    name: "Coinbase Wrapped Staked ETH",
    decimals: 18,
    logoURI: "https://basescan.org/token/images/cbeth_32.png",
  },
];

export default function SwapPage() {
  const { address } = useAccount();

  // State
  const [tokenIn, setTokenIn] = useState<Token>(TOKENS[0]);
  const [tokenOut, setTokenOut] = useState<Token>(TOKENS[2]);
  const [amountIn, setAmountIn] = useState("");
  const [slippage, setSlippage] = useState<number>(0.5);

  const [isSlippageOpen, setIsSlippageOpen] = useState(false);
  const [isTokenSelectorOpen, setIsTokenSelectorOpen] = useState(false);
  const [selectingTarget, setSelectingTarget] = useState<"in" | "out" | null>(null);

  const [quote, setQuote] = useState<any>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // Wagmi balances
  const { data: balanceIn } = useBalance({
    address,
    token: tokenIn.address === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ? undefined : (tokenIn.address as `0x${string}`),
  });
  const { data: balanceOut } = useBalance({
    address,
    token: tokenOut.address === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ? undefined : (tokenOut.address as `0x${string}`),
  });

  const { isApproving, isSwapping, swap, txHash, error: swapError } = useSwap();

  // Flip tokens
  const handleFlip = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountIn("");
    setQuote(null);
  };

  // Debounced Quoting logic
  useEffect(() => {
    let active = true;
    if (!amountIn || Number(amountIn) <= 0) {
      setQuote(null);
      setQuoteError(null);
      setIsQuoting(false);
      return;
    }

    setIsQuoting(true);
    setQuoteError(null);
    setQuote(null);

    const timer = setTimeout(async () => {
      try {
        const query = new URLSearchParams({
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          amountIn: amountIn,
          decimalsIn: tokenIn.decimals.toString(),
          decimalsOut: tokenOut.decimals.toString(),
        });
        const res = await fetch(`/api/swap-quote?${query.toString()}`);
        const data = await res.json();
        if (!active) return;
        if (data.error) {
          setQuoteError(data.error);
        } else {
          setQuote(data);
        }
      } catch (err: any) {
        if (active) setQuoteError(err.message || "Failed to fetch quote");
      } finally {
        if (active) setIsQuoting(false);
      }
    }, 500);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [amountIn, tokenIn.address, tokenOut.address]);

  // Auto-refresh quote every 15s
  useEffect(() => {
    if (!amountIn || !quote) return;
    const interval = setInterval(() => {
      fetch(
        `/api/swap-quote?tokenIn=${tokenIn.address}&tokenOut=${tokenOut.address}&amountIn=${amountIn}&decimalsIn=${tokenIn.decimals}&decimalsOut=${tokenOut.decimals}`
      )
        .then((r) => r.json())
        .then((data) => {
          if (!data.error) setQuote(data);
        })
        .catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, [amountIn, quote, tokenIn, tokenOut]);

  // Swap Execute
  const handleSwap = async () => {
    if (!quote || !amountIn) return;
    try {
      await swap({
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: parseUnits(amountIn, tokenIn.decimals).toString(),
        amountOut: quote.amountOutRaw,
        slippage,
        useV4: quote.route === "v4",
        path: "0x", // In a real implementation this would use the precise path from a router SDK.
      });
    } catch (e) {
      // Error is handled by hook
    }
  };

  const handleMax = () => {
    if (balanceIn) {
      setAmountIn(balanceIn.formatted);
    }
  };

  return (
    <div className="min-h-screen font-dm-sans bg-[#050505] text-white flex flex-col items-center pt-20 px-4">
      {/* Container */}
      <div className="w-full max-w-[390px] backdrop-blur-3xl bg-white/5 border border-white/10 rounded-3xl p-4 shadow-[0_4px_40px_rgba(59,130,246,0.15)] relative overflow-hidden">
        {/* Header */}
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-xl font-syne font-bold">Swap</h1>
          <button
            onClick={() => setIsSlippageOpen(true)}
            className="p-2 hover:bg-white/10 rounded-full transition-colors text-gray-400 hover:text-white"
          >
            ⚙
          </button>
        </div>

        {/* You Pay */}
        <div className="bg-black/60 border border-white/5 rounded-2xl p-4 mb-1">
          <div className="text-sm text-gray-400 mb-2">You Pay</div>
          <div className="flex justify-between items-center">
            <button
              onClick={() => {
                setSelectingTarget("in");
                setIsTokenSelectorOpen(true);
              }}
              className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 transition-colors px-3 py-1.5 rounded-full shadow-sm"
            >
              <img src={tokenIn.logoURI} alt={tokenIn.symbol} className="w-6 h-6 rounded-full" />
              <span className="font-syne font-semibold">{tokenIn.symbol}</span>
              <span className="text-xs text-gray-400">▼</span>
            </button>
            <input
              type="number"
              value={amountIn}
              onChange={(e) => setAmountIn(e.target.value)}
              placeholder="0.0"
              className="bg-transparent text-right text-3xl font-syne outline-none w-1/2 placeholder-gray-600"
            />
          </div>
          <div className="flex justify-between items-center mt-3 text-xs text-gray-400 font-medium">
            <div>
              Bal: {balanceIn ? Number(balanceIn.formatted).toFixed(4) : "0.0000"}
            </div>
            {balanceIn && Number(balanceIn.formatted) > 0 && (
              <button onClick={handleMax} className="text-[#3b82f6] hover:text-blue-400 transition-colors px-1 py-0.5 rounded bg-blue-500/10">
                [MAX]
              </button>
            )}
          </div>
        </div>

        {/* Flip Button */}
        <div className="flex justify-center -my-3 relative z-10">
          <button
            onClick={handleFlip}
            className="bg-[#0f0f0f] border-4 border-[#050505] p-1.5 rounded-xl text-gray-400 hover:text-white hover:bg-white/10 transition-colors shadow-sm"
          >
             ↕
          </button>
        </div>

        {/* You Receive */}
        <div className="bg-black/60 border border-white/5 rounded-2xl p-4 mt-1 mb-4">
          <div className="text-sm text-gray-400 mb-2">You Receive</div>
          <div className="flex justify-between items-center">
            <button
              onClick={() => {
                setSelectingTarget("out");
                setIsTokenSelectorOpen(true);
              }}
              className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 transition-colors px-3 py-1.5 rounded-full shadow-sm"
            >
              <img src={tokenOut.logoURI} alt={tokenOut.symbol} className="w-6 h-6 rounded-full" />
              <span className="font-syne font-semibold">{tokenOut.symbol}</span>
              <span className="text-xs text-gray-400">▼</span>
            </button>
            <div className="text-right text-3xl font-syne w-1/2 truncate">
              {isQuoting ? (
                <span className="animate-pulse text-gray-500">...</span>
              ) : quoteError ? (
                <span className="text-sm text-red-500 font-medium">No route</span>
              ) : quote ? (
                Number(quote.amountOut).toFixed(4)
              ) : (
                <span className="text-gray-600">0.0</span>
              )}
            </div>
          </div>
          <div className="flex justify-between items-center mt-3 text-xs text-gray-400 font-medium">
            <div>
              Bal: {balanceOut ? Number(balanceOut.formatted).toFixed(4) : "0.0000"}
            </div>
          </div>
        </div>

        {/* Quote Details */}
        {quote && !quoteError && !isQuoting && (
          <div className="bg-black/40 border border-white/5 rounded-xl p-4 mb-4 text-xs font-medium text-gray-400 space-y-2.5">
            <div className="flex justify-between">
              <span>Rate</span>
              <span className="text-gray-200">
                1 {tokenIn.symbol} = {Number(quote.executionPrice).toFixed(4)}{" "}
                {tokenOut.symbol}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Price Impact</span>
              <span className={quote.priceImpact > 1 ? "text-red-400" : "text-[#3b82f6]"}>
                {quote.priceImpact}%
              </span>
            </div>
            <div className="flex justify-between">
              <span>Pool Fee</span>
              <span className="text-gray-200">{(quote.poolFee / 10000).toFixed(2)}%</span>
            </div>
            <div className="flex justify-between">
              <span>Protocol Fee</span>
              <span className="text-gray-200">{(quote.protocolFee / 100).toFixed(2)}%</span>
            </div>
            <div className="flex justify-between">
              <span>Route</span>
              <span className="text-[#3b82f6] font-semibold bg-[#3b82f6]/10 px-2 py-0.5 rounded">
                Uniswap {quote.route === "v4" ? "V4" : "V3"}
              </span>
            </div>
          </div>
        )}

        {/* Action Button */}
        <button
          onClick={handleSwap}
          disabled={!amountIn || isQuoting || !!quoteError || isApproving || isSwapping}
          className="w-full bg-[#3b82f6] hover:bg-blue-500 disabled:bg-[#1a1a1a] disabled:text-gray-500 disabled:border-white/5 disabled:border text-white font-syne font-bold py-4 rounded-xl transition-all shadow-[0_0_15px_rgba(59,130,246,0.3)] disabled:shadow-none"
        >
          {isApproving
            ? "Approving..."
            : isSwapping
            ? "Swapping..."
            : quoteError
            ? quoteError
            : "Review Swap"}
        </button>

        {/* Errors/Success */}
        {swapError && <div className="mt-4 text-sm text-red-500 text-center font-medium bg-red-500/10 p-2 rounded-lg break-words">{swapError}</div>}
        {txHash && (
          <div className="mt-4 text-sm text-green-400 text-center font-medium bg-green-500/10 p-3 rounded-xl break-words relative overflow-hidden">
            <div className="relative z-10">
              Swap successful! 🎉
              <br />
              <a
                href={`https://basescan.org/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
                className="text-white hover:underline mt-1 inline-block"
              >
                View on Basescan
              </a>
            </div>
            {/* Sparkles Effect Background */}
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-green-500/20 via-transparent to-transparent opacity-50"></div>
          </div>
        )}
      </div>

      {/* Slippage Panel */}
      {isSlippageOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md transition-opacity">
          <div className="bg-[#0f0f0f] border border-white/10 rounded-2xl p-5 w-full max-w-[320px] shadow-2xl">
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-lg font-syne font-bold">Swap settings</h2>
              <button onClick={() => setIsSlippageOpen(false)} className="text-gray-400 hover:text-white p-1 rounded-full hover:bg-white/10 transition-colors">✕</button>
            </div>
            
            <div className="mb-2 text-sm text-gray-400 font-medium">Max slippage</div>
            <div className="flex gap-2 mb-4">
              {[0.1, 0.5, 1.0].map((val) => (
                <button
                  key={val}
                  onClick={() => setSlippage(val)}
                  className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${
                    slippage === val
                      ? "bg-[#3b82f6]/20 border border-[#3b82f6] text-[#3b82f6]"
                      : "bg-black/50 border border-white/5 text-gray-400 hover:bg-white/5"
                  }`}
                >
                  {val}%
                </button>
              ))}
            </div>
            
            <div className="flex items-center gap-2 bg-black/50 border border-white/5 focus-within:border-[#3b82f6]/50 rounded-xl p-3 transition-colors">
              <input
                type="number"
                value={slippage}
                onChange={(e) => setSlippage(Number(e.target.value))}
                className="bg-transparent text-right w-full outline-none font-syne text-lg placeholder-gray-600"
                placeholder="Custom"
              />
              <span className="text-gray-400 font-medium">%</span>
            </div>
            
            <button
              onClick={() => setIsSlippageOpen(false)}
              className="w-full mt-6 bg-[#1a1a1a] hover:bg-white/10 p-3 rounded-xl font-syne font-semibold transition-colors text-white"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Token Selector Modal */}
      {isTokenSelectorOpen && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end sm:items-center sm:justify-center bg-black/60 backdrop-blur-md">
          <div className="bg-[#0f0f0f] border border-white/10 rounded-t-3xl sm:rounded-3xl w-full max-w-[390px] h-[80vh] sm:h-[600px] flex flex-col pointer-events-auto shadow-2xl animate-slide-up sm:animate-none">
            <div className="p-4 border-b border-white/5 flex justify-between items-center shrink-0">
              <h2 className="font-syne font-bold text-lg">Select a token</h2>
              <button
                onClick={() => setIsTokenSelectorOpen(false)}
                className="text-gray-400 hover:text-white p-1 rounded-full hover:bg-white/10 transition-colors"
              >
                ✕
              </button>
            </div>
            
            <div className="p-4 shrink-0">
              <input
                type="text"
                placeholder="Search name or paste address"
                className="w-full bg-black/50 border border-white/5 rounded-xl px-4 py-3 outline-none focus:border-[#3b82f6] transition-colors placeholder-gray-500 font-medium text-sm text-white"
              />
            </div>
            
            <div className="px-4 pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Popular Tokens
            </div>
            
            <div className="overflow-y-auto flex-1 px-2 pb-2">
              {TOKENS.map((token) => (
                <button
                  key={token.address}
                  className="w-full flex items-center justify-between p-3 hover:bg-white/5 rounded-2xl transition-colors group"
                  onClick={() => {
                    if (selectingTarget === "in") setTokenIn(token);
                    else if (selectingTarget === "out") setTokenOut(token);
                    setIsTokenSelectorOpen(false);
                  }}
                >
                  <div className="flex items-center gap-4">
                    <img src={token.logoURI} alt={token.symbol} className="w-9 h-9 rounded-full shadow-sm" />
                    <div className="text-left">
                      <div className="font-syne font-bold text-gray-200 group-hover:text-white transition-colors">{token.symbol}</div>
                      <div className="text-xs text-gray-500 font-medium">{token.name}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
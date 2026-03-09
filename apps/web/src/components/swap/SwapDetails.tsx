import React from 'react';
import { formatSwapAmount } from '../../lib/utils';
import { Token } from '../../types/swap';

interface SwapDetailsProps {
  rate: number;
  inputSymbol: string;
  outputSymbol: string;
  priceImpact: number;
  minReceived: string;
  networkFeeUsd?: number;
}

export function SwapDetails({
  rate,
  inputSymbol,
  outputSymbol,
  priceImpact,
  minReceived,
  networkFeeUsd
}: SwapDetailsProps) {
  // Determine impact color
  let impactColor = 'text-green-400';
  if (priceImpact > 1.5) impactColor = 'text-yellow-400';
  if (priceImpact > 3.0) impactColor = 'text-red-400';

  return (
    <div className="mt-4 p-4 bg-[#131A2A] rounded-2xl border border-[#1B2236] text-sm font-medium">
      <div className="flex items-center justify-between text-gray-400 mb-3">
        <span>Rate</span>
        <span className="text-white">
          1 {inputSymbol} = {formatSwapAmount(rate, 6)} {outputSymbol}
        </span>
      </div>

      <div className="flex items-center justify-between text-gray-400 mb-3">
        <span>Price Impact</span>
        <span className={impactColor}>
          {priceImpact < 0.01 ? '<0.01' : priceImpact.toFixed(2)}%
        </span>
      </div>

      <div className="flex items-center justify-between text-gray-400 mb-3">
        <span>Minimum Received</span>
        <span className="text-white">
          {formatSwapAmount(minReceived, 6)} {outputSymbol}
        </span>
      </div>

      {networkFeeUsd !== undefined && (
        <div className="flex items-center justify-between text-gray-400">
          <span>Network Fee</span>
          <span className="text-white">
            ${formatSwapAmount(networkFeeUsd, 2)}
          </span>
        </div>
      )}
    </div>
  );
}

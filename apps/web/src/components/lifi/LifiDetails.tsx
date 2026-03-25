import React from 'react';
import { formatSwapAmount } from '../../lib/utils';
import { Token } from '../../types/lifi';

interface LifiDetailsProps {
  rate: number;
  inputSymbol: string;
  outputSymbol: string;
  priceImpact: number;
  minReceived: string;
  networkFeeUsd?: number;
}

export function LifiDetails({
  rate,
  inputSymbol,
  outputSymbol,
  priceImpact,
  minReceived,
  networkFeeUsd
}: LifiDetailsProps) {
  // Determine impact color
  let impactColor = 'text-green-400';
  if (priceImpact > 1.5) impactColor = 'text-yellow-400';
  if (priceImpact > 3.0) impactColor = 'text-red-400';

  return (
    <div className="mt-4 lifi-quote-info">
      <div className="lifi-quote-row">
        <span>Rate</span>
        <span className="value">
          1 {inputSymbol} = {formatSwapAmount(rate, 6)} {outputSymbol}
        </span>
      </div>

      <div className="lifi-quote-row">
        <span>Price Impact</span>
        <span className={impactColor.replace('text-green-400', 'success').replace('text-red-400', 'warning').replace('text-yellow-400', 'text-yellow-500 font-semibold')}>
          {priceImpact < 0.01 ? '<0.01' : priceImpact.toFixed(2)}%
        </span>
      </div>

      <div className="lifi-quote-row">
        <span>Minimum Received</span>
        <span className="value">
          {formatSwapAmount(minReceived, 6)} {outputSymbol}
        </span>
      </div>

      {networkFeeUsd !== undefined && (
        <div className="lifi-quote-row">
          <span>Network Fee</span>
          <span className="value">
            ${formatSwapAmount(networkFeeUsd, 2)}
          </span>
        </div>
      )}
    </div>
  );
}

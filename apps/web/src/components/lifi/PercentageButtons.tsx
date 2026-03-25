import React, { useCallback } from 'react';
import { type Address } from 'viem';
import { formatTokenAmount, calculatePercentage } from '../../lib/utils';
import { NATIVE_ETH } from '../../lib/tokens';

interface PercentageButtonsProps {
  balance: bigint;
  decimals: number;
  tokenAddress: Address;
  onSelect: (amount: string, percent: number) => void;
  selectedPercent: number | null;
}

export function PercentageButtons({
  balance,
  decimals,
  tokenAddress,
  onSelect,
  selectedPercent,
}: PercentageButtonsProps) {
  const percentages = [25, 50, 75, 100];
  const isNative = tokenAddress === NATIVE_ETH;

  const handlePercentClick = useCallback(
    (percent: number) => {
      if (balance <= 0n) return;

      let amount: bigint;

      if (isNative && percent === 100) {
        // Reserve 0.00001 ETH for gas when selecting 100% native
        const gasReserve = 10000000000000n; // 0.00001 * 10^18
        const spendable = balance > gasReserve ? balance - gasReserve : 0n;
        amount = spendable;
      } else if (isNative) {
        const gasReserve = 10000000000000n; // 0.00001 * 10^18
        const spendable = balance > gasReserve ? balance - gasReserve : 0n;
        amount = calculatePercentage(spendable, percent);
      } else {
        // For standard ERC20, use straight percentage rounding down native (BigInt div rounds down safely)
        amount = calculatePercentage(balance, percent);
      }

      // Format safely explicitly down to string. When 100% Native, output precise balance - fee.
      const formatted = formatTokenAmount(amount, decimals);
      onSelect(formatted, percent);
    },
    [balance, decimals, isNative, onSelect]
  );

  if (balance <= 0n) {
    return (
      <div className="grid grid-cols-4 gap-2 mt-3">
        {percentages.map((pct) => (
          <button
            key={pct}
            disabled
            className="px-2 py-2 text-sm font-semibold rounded-xl bg-[#1B2236]/30 text-gray-600 cursor-not-allowed min-h-[44px]"
          >
            {pct}%
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-4 gap-2 mt-3">
      {percentages.map((pct) => (
        <button
          key={pct}
          onClick={() => handlePercentClick(pct)}
          className={`px-2 py-2 text-sm font-semibold rounded-xl transition-all duration-200 min-h-[44px] ${
            selectedPercent === pct
              ? 'bg-orange-500 text-white shadow-[0_0_12px_rgba(249,115,22,0.4)]'
              : 'bg-[#1B2236] text-gray-400 hover:text-white hover:bg-[#293249]'
          }`}
        >
          {pct}%
        </button>
      ))}
    </div>
  );
}

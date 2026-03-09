import React, { useRef } from 'react';
import { Token } from '../../types/swap';
import { formatSwapAmount } from '../../lib/utils';

interface TokenInputProps {
  label: string;
  amount: string;
  onAmountChange?: (val: string) => void;
  token: Token | null;
  onSelectToken: () => void;
  balanceFormatted?: string;
  usdValue?: number;
  readonly?: boolean;
  onMaxClick?: () => void;
}

export function TokenInput({
  label,
  amount,
  onAmountChange,
  token,
  onSelectToken,
  balanceFormatted,
  usdValue,
  readonly = false,
  onMaxClick
}: TokenInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleContainerClick = () => {
    if (!readonly && inputRef.current) {
      inputRef.current.focus();
    }
  };

  return (
    <div 
      className="swap-glass-inner p-4 mb-2 transition-all hover:border-dust-purple/30 border border-transparent"
      onClick={handleContainerClick}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-400">{label}</span>
      </div>
      
      <div className="flex items-center justify-between gap-4">
        <input
          ref={inputRef}
          type="number"
          value={amount}
          onChange={(e) => onAmountChange?.(e.target.value)}
          placeholder="0"
          readOnly={readonly}
          className={`swap-token-input flex-1 ${readonly ? 'cursor-default' : ''}`}
        />
        
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSelectToken();
          }}
          className="swap-token-button shrink-0 shadow-sm"
        >
          {token ? (
            <>
              {token.logoURI ? (
                <img src={token.logoURI} alt={token.symbol} className="w-6 h-6 rounded-full" />
              ) : (
                <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-[10px] font-bold text-white">
                  {token.symbol[0]}
                </div>
              )}
              <span className="text-lg font-semibold text-white">{token.symbol}</span>
            </>
          ) : (
            <span className="text-lg font-semibold text-white px-2">Select token</span>
          )}
          <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      <div className="flex items-center justify-between mt-3 h-5">
        <div className="text-sm text-gray-500 font-medium">
          {usdValue !== undefined && usdValue > 0 && typeof amount === 'string' && parseFloat(amount) > 0 ? (
            `$${formatSwapAmount(usdValue)}`
          ) : null}
        </div>
        
        <div className="flex items-center gap-2">
          {balanceFormatted !== undefined && (
            <div className="flex items-center gap-2 text-sm text-gray-400 font-medium">
              <span>Balance: {formatSwapAmount(balanceFormatted)}</span>
              {!readonly && onMaxClick && parseFloat(balanceFormatted) > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onMaxClick();
                  }}
                  className="text-orange-500 hover:text-orange-400 min-h-[44px] px-2 -mr-2"
                >
                  Max
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

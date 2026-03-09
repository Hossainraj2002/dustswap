// BigInt percentage calculator explicitly required by UI specs
export function calculatePercentage(balance: bigint, percentage: number): bigint {
  return (balance * BigInt(percentage)) / 100n;
}

// Format token amount ensuring trailing zeros are trimmed appropriately
export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (amount === 0n) return '0';
  const divisor = 10n ** BigInt(decimals);
  const integerPart = amount / divisor;
  const fractionalPart = amount % divisor;
  
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0').slice(0, 6);
  const trimmedFractional = fractionalStr.replace(/0+$/, '');
  
  return trimmedFractional ? `${integerPart}.${trimmedFractional}` : integerPart.toString();
}

/**
 * Format string/number swap amount for UI consistency
 */
export function formatSwapAmount(value: string | number, decimals: number = 6): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '0';
  if (num === 0) return '0';
  if (num < 0.000001) return '<0.000001';
  if (num < 1) return num.toFixed(decimals >= 6 ? 6 : decimals).replace(/0+$/, '').replace(/\.$/, '');
  if (num < 1000) return num.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

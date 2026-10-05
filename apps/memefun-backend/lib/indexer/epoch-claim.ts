/** Keep the claim count even for a zero leaf: the contract still consumes its bitmap index. */
export function epochClaimAccounting(
  current: { total: bigint; claimed: bigint; claims: number; released: boolean } | null,
  amount: bigint,
): { claimed: bigint; claims: number } | null {
  if (!current) {
    if (amount !== 0n) throw new Error(`Unreserved epoch market claimed ${amount}; reserve event is missing`);
    return null;
  }
  if (current.released) throw new Error("Claim on an epoch market already released");
  const claimed = current.claimed + amount;
  if (claimed > current.total) throw new Error(`Epoch claims ${claimed} exceed reserved total ${current.total}`);
  return { claimed, claims: current.claims + 1 };
}

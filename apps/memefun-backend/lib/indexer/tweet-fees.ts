/** Author fees subdivide the existing creator share; platform/referral/destination math stays fixed. */
export function tweetCreatorSplit(creator: bigint, attribution: { authorShareBps: number } | null) {
  if (!attribution) return { launcher: creator, author: 0n };
  if (!Number.isInteger(attribution.authorShareBps) || attribution.authorShareBps < 2_000 || attribution.authorShareBps > 10_000) throw new Error("Invalid indexed author fee share");
  const author = creator * BigInt(attribution.authorShareBps) / 10_000n;
  // Time unlocks treasury withdrawals from the same pot; it never changes fee allocation.
  return { launcher: creator - author, author };
}

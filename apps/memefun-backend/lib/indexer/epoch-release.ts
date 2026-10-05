/** Contract releases return exactly the reserved total less prior claims, once per market. */
export function epochReleaseAccounting(
  current: { total: bigint; claimed: bigint; released: boolean } | null,
  returned: bigint,
): { released: true; returned: bigint } | null {
  if (!current) {
    if (returned !== 0n) throw new Error(`Unreserved epoch market returned ${returned}; reserve event is missing`);
    return null;
  }
  if (current.released) return null;
  const expected = current.total - current.claimed;
  if (returned !== expected) throw new Error(`Epoch release returned ${returned}, expected unclaimed reserve ${expected}`);
  return { released: true, returned };
}

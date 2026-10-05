/** Decimal percent to integer basis points without floating-point multiplication. */
export function parseFeePercent(text: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const bps = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return bps <= 10_000n ? Number(bps) : null;
}

import { cn } from "@/lib/cn";
import { hashString } from "@/lib/preview/random";

const PALETTE = ["#0052FF", "#5E5CE6", "#BF5AF2", "#FF2D55", "#FF9F0A", "#FFD60A", "#30D158", "#00C7BE", "#64D2FF", "#AC8E68"];

/** Deterministic gradient avatar for a wallet address. Decorative. */
export function AddressAvatar({ address, size = 28, className }: { address: string; size?: number; className?: string }) {
  const hash = hashString(address.toLowerCase());
  const a = PALETTE[hash % PALETTE.length] as string;
  const b = PALETTE[(hash >>> 8) % PALETTE.length] as string;
  const angle = (hash >>> 16) % 360;
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 rounded-full", className)}
      style={{ width: size, height: size, background: `linear-gradient(${angle}deg, ${a}, ${b})` }}
    />
  );
}

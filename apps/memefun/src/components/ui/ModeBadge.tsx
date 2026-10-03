import { Flame, HandCoins, Layers, UsersRound, type LucideIcon } from "lucide-react";
import type { FeeMode } from "@/core/types";
import { Badge } from "./display";

export const MODE_META: Record<
  FeeMode,
  { label: string; short: string; icon: LucideIcon; tone: "creator" | "burn" | "holders" | "floor"; color: string; description: string; destinationLabel: string }
> = {
  creator: {
    label: "Creator earns",
    short: "Creator",
    icon: HandCoins,
    tone: "creator",
    color: "var(--mf-mode-creator)",
    description: "The creator's share of every fee is paid out in the pair asset, claimable any time.",
    destinationLabel: "Creator",
  },
  burn: {
    label: "Buyback and burn",
    short: "Burn",
    icon: Flame,
    tone: "burn",
    color: "var(--mf-mode-burn)",
    description: "Fees buy the coin back from its own pool and send it to a burn address, shrinking supply.",
    destinationLabel: "Buyback and burn",
  },
  holders: {
    label: "Holder rewards",
    short: "Holders",
    icon: UsersRound,
    tone: "holders",
    color: "var(--mf-mode-holders)",
    description: "Fees are paid to holders in proportion to what they hold, every epoch.",
    destinationLabel: "Holders",
  },
  floor: {
    label: "Liquidity floor",
    short: "Floor",
    icon: Layers,
    tone: "floor",
    color: "var(--mf-mode-floor)",
    description: "Fees become permanent buy-side liquidity under the price that nobody can withdraw.",
    destinationLabel: "Floor liquidity",
  },
};

export function ModeBadge({ mode, compact = false }: { mode: FeeMode; compact?: boolean }) {
  const meta = MODE_META[mode];
  const Icon = meta.icon;
  return (
    <Badge tone={meta.tone} icon={<Icon aria-hidden />}>
      {compact ? meta.short : meta.label}
    </Badge>
  );
}

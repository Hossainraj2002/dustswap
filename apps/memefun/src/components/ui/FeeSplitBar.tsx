import { feeShareFractions, type FeeSplitConfig } from "@/core/fees";
import { cn } from "@/lib/cn";
import { MODE_META } from "./ModeBadge";

interface FeeSplitBarProps {
  config: FeeSplitConfig;
  hasReferrer?: boolean;
  /** Total fee in bps; when given, legend shows each share as % of the trade too. */
  feeBps?: number;
  className?: string;
  showLegend?: boolean;
  authorShareBps?: number;
}

interface Segment {
  key: string;
  label: string;
  fraction: number;
  color: string;
}

/** Where every fee goes, as a stacked bar with a legend. */
export function FeeSplitBar({ config, hasReferrer = false, feeBps, className, showLegend = true, authorShareBps = 0 }: FeeSplitBarProps) {
  const fractions = feeShareFractions(config, hasReferrer);
  const meta = MODE_META[config.mode];
  const author = fractions.creator * authorShareBps / 10_000;
  const segments: Segment[] = [
    { key: "creator", label: authorShareBps ? "Launcher" : config.mode === "creator" ? "Creator" : "Creator keeps", fraction: fractions.creator - author, color: "var(--mf-mode-creator)" },
    { key: "author", label: "Post author", fraction: author, color: "var(--mf-referral)" },
    { key: "destination", label: meta.destinationLabel, fraction: fractions.destination, color: meta.color },
    { key: "referral", label: "Referrer", fraction: fractions.referral, color: "var(--mf-referral)" },
    { key: "platform", label: "Platform", fraction: fractions.platform, color: "var(--mf-mode-platform)" },
  ].filter((segment) => segment.fraction > 0.00001);

  const describe = (fraction: number) => {
    const ofFee = `${trim(fraction * 100)}%`;
    return feeBps === undefined ? ofFee : `${ofFee} (${trim((fraction * feeBps) / 100)}% of trade)`;
  };

  return (
    <div className={cn("@container flex flex-col gap-3", className)}>
      <div
        role="img"
        aria-label={`Fee split: ${segments.map((s) => `${s.label} ${trim(s.fraction * 100)} percent`).join(", ")}`}
        className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full"
      >
        {segments.map((segment) => (
          <span
            key={segment.key}
            className="h-full transition-[flex-grow] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] first:rounded-l-full last:rounded-r-full"
            style={{ flexGrow: segment.fraction, flexBasis: 0, backgroundColor: segment.color }}
          />
        ))}
      </div>
      {showLegend ? (
        <ul className="grid grid-cols-1 gap-x-4 gap-y-1.5 @lg:grid-cols-2" aria-hidden>
          {segments.map((segment) => (
            <li key={segment.key} className="flex items-center gap-2 text-footnote">
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: segment.color }} />
              <span className="text-label">{segment.label}</span>
              <span className="mf-num ml-auto text-label-2 @lg:ml-0">{describe(segment.fraction)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function trim(value: number) {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

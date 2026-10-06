import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck, ChevronDown } from "lucide-react";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { FeeSplitBar } from "@/components/ui/FeeSplitBar";
import { MODE_META } from "@/components/ui/ModeBadge";
import type { FeeMode } from "@/core/types";

export const metadata: Metadata = {
  title: "How it works",
  description: "How memefun launches coins, where trading fees go, and what the contracts guarantee.",
};

const platformPct = DEFAULT_SETTINGS.platformShareBps / 100;
const referralPct = DEFAULT_SETTINGS.referralShareBps / 100;

const steps = [
  { title: "Make your coin", body: "Pick a name, a ticker, an image and the asset it trades against: ETH, USDC or a tokenized stock." },
  { title: "One transaction creates it", body: "The coin is created on Base with a fixed supply of 1,000,000,000 and no admin key. Nobody can mint more." },
  { title: "The supply goes into the pool", body: "In the same transaction the whole supply goes into a Uniswap v4 pool, and that liquidity is locked forever." },
  { title: "Trading starts", body: "It can be traded on memefun, Uniswap and anywhere that routes Uniswap v4. Your optional first buy lands before anyone else's." },
];

const guarantees = [
  "Supply is fixed at 1,000,000,000. Nobody can mint more.",
  "There is no owner or admin key. Nobody can pause, block or seize transfers.",
  "The whole supply goes into the pool at launch. The team does not get an allocation.",
  "Pool liquidity is locked forever. Nobody can withdraw it, including us.",
  "A coin's fee can only go down, never up.",
  "Where a coin's fees go is fixed at launch and can never be changed.",
  "Changes to platform settings only apply to coins launched afterwards.",
];

const faqs = [
  {
    q: "Can the creator pull the liquidity?",
    a: "No. The liquidity is added by the launch contract itself and there is no function that removes it. Not the creator, not memefun, not anyone.",
  },
  {
    q: "Can a coin's fee go up later?",
    a: "No. The creator can lower the fee at any time. Raising it is impossible.",
  },
  {
    q: "What happens to fees paid during launch protection?",
    a: "They are split exactly like normal fees: the platform share first, then the coin's chosen destination. Snipers end up funding the creator or the community.",
  },
  {
    q: "How are holder rewards paid?",
    a: "Fees build up during each hour. At the end of the hour, the amount is divided among holders by how much they held, and each holder claims their share on the Rewards page.",
  },
  {
    q: "How does buyback and burn work?",
    a: "Fees are saved up and used to buy the coin from its own pool in small batches. The bought coins go to a burn address that nobody controls, so the supply in circulation shrinks.",
  },
  {
    q: "What is the liquidity floor?",
    a: "Fees are added to the pool as buy-side liquidity under the current price. It can never be withdrawn, so it keeps a growing bid under the coin.",
  },
  {
    q: "What does memefun charge?",
    a: `The platform keeps ${platformPct}% of each trading fee, and creating a coin is free during launch. Nothing else is taken from trades.`,
  },
  {
    q: "Are the contracts audited?",
    a: "The contracts are deployed on Base mainnet. Automated code review has been performed, but a professional independent audit has not been completed. Live mode uses real funds; preview mode uses simulated market data and transactions.",
  },
];

export default function HowItWorksPage() {
  return (
    <>
      <PageHeader title="How it works" subtitle="Every coin launches the same way, and the contracts enforce the rules." />
      <div className="flex flex-col gap-10">
        <section aria-labelledby="launching" className="flex flex-col gap-4">
          <h2 id="launching" className="text-title2 text-label">
            Launching a coin
          </h2>
          <ol className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {steps.map((step, index) => (
              <li key={step.title} className="mf-card flex flex-col gap-2 p-5">
                <span className="flex size-8 items-center justify-center rounded-full bg-tint-fill text-subhead font-bold text-on-tint" aria-hidden>
                  {index + 1}
                </span>
                <h3 className="text-headline text-label">{step.title}</h3>
                <p className="text-subhead text-label-2">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="guaranteed" className="mf-card flex flex-col gap-4 p-5 sm:p-6">
          <h2 id="guaranteed" className="text-title2 text-label">
            What is guaranteed
          </h2>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {guarantees.map((text) => (
              <li key={text} className="flex gap-2.5 text-body text-label">
                <CircleCheck className="mt-0.5 size-5 shrink-0 text-up" aria-hidden />
                {text}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="fees" className="flex flex-col gap-4">
          <div>
            <h2 id="fees" className="text-title2 text-label">
              Where trading fees go
            </h2>
            <p className="mt-1 max-w-3xl text-body text-label-2">
              Each coin charges a fee between {DEFAULT_SETTINGS.feeMinBps / 100}% and {DEFAULT_SETTINGS.feeMaxBps / 100}% on every buy and sell, always paid in the asset it trades against. The platform keeps {platformPct}% of
              each fee. The creator picks where the rest goes, once, at launch.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {(Object.keys(MODE_META) as FeeMode[]).map((mode) => {
              const meta = MODE_META[mode];
              const Icon = meta.icon;
              return (
                <article key={mode} className="mf-card flex flex-col gap-4 p-5">
                  <div className="flex items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-full" style={{ backgroundColor: `color-mix(in srgb, ${meta.color} 14%, transparent)`, color: meta.color }}>
                      <Icon className="size-5" aria-hidden />
                    </span>
                    <h3 className="text-headline text-label">{meta.label}</h3>
                  </div>
                  <p className="text-subhead text-label-2">{meta.description}</p>
                  <FeeSplitBar
                    config={{ mode, platformShareBps: DEFAULT_SETTINGS.platformShareBps, referralShareBps: DEFAULT_SETTINGS.referralShareBps, creatorKeepBps: mode === "creator" ? 0 : 2500 }}
                  />
                  {mode !== "creator" ? <p className="text-footnote text-label-2">Shown with the creator keeping 25%. Creators can keep between 0% and 50% in this mode.</p> : null}
                </article>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="protection" className="mf-card grid grid-cols-1 items-center gap-6 p-5 sm:p-6 lg:grid-cols-[1fr_420px]">
          <div className="flex flex-col gap-2">
            <h2 id="protection" className="text-title2 text-label">
              Launch protection
            </h2>
            <p className="text-body text-label-2">
              Bots try to buy new coins in the first block. To make that a bad deal, the fee starts at {DEFAULT_SETTINGS.snipeStartBps / 100}% and falls in a straight line to the coin&apos;s normal fee over{" "}
              {DEFAULT_SETTINGS.snipeDurationSec} seconds. Waiting a few seconds costs nothing. The creator&apos;s first buy is part of the launch transaction, so it pays the normal fee.
            </p>
          </div>
          <ProtectionCurve />
        </section>

        <section aria-labelledby="rings" className="mf-card flex flex-col gap-5 p-5 sm:p-6">
          <div>
            <h2 id="rings" className="text-title2 text-label">
              Milestone rings
            </h2>
            <p className="mt-1 max-w-3xl text-body text-label-2">
              The ring around every coin fills as its market cap climbs toward the next milestone: $10K, $25K, $69K, $100K and on up to $1B. When it closes, the creator gets a
              share card for the moment. In a coin&apos;s first seconds the ring turns orange and counts down its launch protection instead.
            </p>
          </div>
          <div className="flex flex-wrap gap-8">
            {[
              { label: "On its way to $25K", ring: { kind: "milestone" as const, progress: 0.3 } },
              { label: "Almost at $69K", ring: { kind: "milestone" as const, progress: 0.85 } },
              { label: "Launch protection", ring: { kind: "protection" as const, remaining: 0.6 } },
            ].map((example) => (
              <figure key={example.label} className="flex flex-col items-center gap-2">
                <CoinAvatar alt="" size={72} ring={example.ring} symbol="MF" />
                <figcaption className="text-footnote text-label-2">{example.label}</figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section aria-labelledby="referrals" className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <article className="mf-card flex flex-col gap-2 p-5">
            <h2 id="referrals" className="text-title3 text-label">
              Referrals
            </h2>
            <p className="text-subhead text-label-2">
              Every link you share from memefun carries your wallet. When the people it brings trade, you get {referralPct}% of the platform&apos;s share of their fees. Traders never
              pay more because of it, and creators never get less.
            </p>
          </article>
          <article className="mf-card flex flex-col gap-2 p-5">
            <h2 className="text-title3 text-label">Pairs</h2>
            <p className="text-subhead text-label-2">
              Coins trade against ETH, USDC or a Coinbase tokenized stock, and every pair opens at the same market cap. Pairing a coin with a stock gives no ownership of the company.
              Tokenized stocks are only offered outside the United States.
            </p>
          </article>
        </section>

        <section aria-labelledby="faq" className="flex flex-col gap-4">
          <h2 id="faq" className="text-title2 text-label">
            Questions
          </h2>
          <div className="mf-card overflow-hidden [&>details+details]:hairline-t">
            {faqs.map((faq) => (
              <details key={faq.q} className="group">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-5 py-3 text-body font-semibold text-label [&::-webkit-details-marker]:hidden">
                  {faq.q}
                  <ChevronDown className="size-5 shrink-0 text-label-2 transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <p className="px-5 pb-4 text-subhead text-label-2">{faq.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section aria-labelledby="risk" className="flex flex-col gap-3 rounded-lg bg-fill-4 p-5">
          <h2 id="risk" className="text-headline text-label">
            Know the risk
          </h2>
          <p className="text-subhead text-label-2">
            Meme coins are extremely volatile and most lose nearly all of their value. The guarantees above protect you from a creator changing the rules, not from the price going
            down. Only trade what you can afford to lose.
          </p>
          <div>
            <Button asChild>
              <Link href="/create">Create a coin</Link>
            </Button>
          </div>
        </section>
      </div>
    </>
  );
}

/** The launch-protection fee schedule, drawn from the default settings. */
function ProtectionCurve() {
  const start = DEFAULT_SETTINGS.snipeStartBps / 100;
  const normal = DEFAULT_SETTINGS.defaultFeeBps / 100;
  const seconds = DEFAULT_SETTINGS.snipeDurationSec;
  const width = 420;
  const height = 200;
  const pad = { left: 40, right: 12, top: 12, bottom: 28 };
  const x = (t: number) => pad.left + (t / (seconds + 5)) * (width - pad.left - pad.right);
  const y = (fee: number) => pad.top + (1 - fee / start) * (height - pad.top - pad.bottom);
  const path = `M${x(0)} ${y(start)} L${x(seconds)} ${y(normal)} L${x(seconds + 5)} ${y(normal)}`;
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={`Fee falls from ${start}% at launch to ${normal}% after ${seconds} seconds`}>
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--mf-separator)" />
        <line x1={pad.left} x2={pad.left} y1={pad.top} y2={y(0)} stroke="var(--mf-separator)" />
        <path d={`${path} L${x(seconds + 5)} ${y(0)} L${x(0)} ${y(0)} Z`} fill="var(--mf-warning-ring)" opacity="0.14" />
        <path d={path} fill="none" stroke="var(--mf-warning-ring)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <text x={pad.left - 6} y={y(start) + 4} textAnchor="end" fontSize="11" fill="var(--mf-label-2)">
          {start}%
        </text>
        <text x={pad.left - 6} y={y(normal) + 4} textAnchor="end" fontSize="11" fill="var(--mf-label-2)">
          {normal}%
        </text>
        <text x={x(0)} y={height - 8} fontSize="11" fill="var(--mf-label-2)">
          Launch
        </text>
        <text x={x(seconds)} y={height - 8} textAnchor="middle" fontSize="11" fill="var(--mf-label-2)">
          {seconds}s
        </text>
      </svg>
    </figure>
  );
}

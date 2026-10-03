"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { KeyRound, ShieldCheck, TriangleAlert } from "lucide-react";
import { HARD_CAPS } from "@/core/constants";
import { DEFAULT_SETTINGS, SETTING_SPECS, diffSettings, validateSettings, type LaunchSettings, type SettingSpec } from "@/core/settings";
import type { FeeMode, QuoteKind } from "@/core/types";
import { ownerCalls } from "@/lib/admin/ownerCalls";
import { cn } from "@/lib/cn";
import { useCoins, useLaunchSettings, useModeration } from "@/lib/market/hooks";
import { useLiveMarket, useMarket } from "@/lib/market/MarketProvider";
import { TxError } from "@/lib/market/Market";
import { usePreview } from "@/lib/preview/scenario";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { Badge } from "@/components/ui/display";
import { MODE_META } from "@/components/ui/ModeBadge";
import { Sheet } from "@/components/ui/Sheet";
import { Switch } from "@/components/ui/Switch";
import { TextArea, TextField } from "@/components/ui/TextField";

const TOKEN_KEY = "memefun-admin-token";

/** IDs referenced by aria-labelledby must not contain spaces. */
function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function toDisplay(spec: SettingSpec, value: number): string {
  if (spec.unit === "bps") return String(value / 100);
  return String(value);
}

function fromDisplay(spec: SettingSpec, text: string): number {
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return Number.NaN;
  return spec.unit === "bps" ? Math.round(parsed * 100) : parsed;
}

function unitLabel(spec: SettingSpec) {
  return spec.unit === "bps" ? "%" : spec.unit === "sec" ? "s" : spec.unit === "usd" ? "USD" : "ETH";
}

function boundsText(spec: SettingSpec) {
  const f = (value: number) => (spec.unit === "bps" ? `${value / 100}%` : spec.unit === "usd" ? `$${value.toLocaleString("en-US")}` : spec.unit === "sec" ? `${value}s` : `${value} ETH`);
  return `Between ${f(spec.min)} and ${f(spec.max)}.`;
}

const GROUPS: Array<{ title: string; keys: SettingSpec["key"][] }> = [
  { title: "Trading fees", keys: ["feeMinBps", "feeMaxBps", "defaultFeeBps", "platformShareBps", "referralShareBps", "creatorKeepMaxBps"] },
  { title: "Launches", keys: ["creationFeeEth", "openingFdvUsd", "snipeStartBps", "snipeDurationSec"] },
];

export function AdminScreen() {
  const { scenario, preview } = usePreview();
  const wallet = useWallet();
  const { market } = useMarket();
  const live = useLiveMarket();
  const current = useLaunchSettings() ?? DEFAULT_SETTINGS;
  const [unlocked, setUnlocked] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [draft, setDraft] = useState<LaunchSettings>(current);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState(false);
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    if (scenario === "admin") setUnlocked(true);
    try {
      if (window.sessionStorage.getItem(TOKEN_KEY)) setUnlocked(true);
    } catch {
      // Ignore.
    }
  }, [scenario]);

  // Live moderation reads and writes carry the token.
  useEffect(() => {
    if (!live || !unlocked) return;
    let token: string | null = null;
    try {
      token = window.sessionStorage.getItem(TOKEN_KEY);
    } catch {
      token = null;
    }
    live.setAdminToken(token);
    return () => live.setAdminToken(null);
  }, [live, unlocked]);

  // Follow live settings until the admin starts editing.
  const dirtyKeys = useMemo(() => diffSettings(current, draft), [current, draft]);
  useEffect(() => {
    if (dirtyKeys.length === 0) setDraft(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const issues = validateSettings(draft);
  const calls = ownerCalls(current, draft);

  const unlock = () => {
    if (!tokenInput.trim()) return;
    try {
      window.sessionStorage.setItem(TOKEN_KEY, tokenInput.trim());
    } catch {
      // Ignore.
    }
    setUnlocked(true);
  };

  if (!unlocked) {
    return (
      <>
        <PageHeader title="Settings" />
        <div className="mx-auto flex max-w-md flex-col gap-4">
          <div className="mf-card flex flex-col gap-4 p-6">
            <span className="flex size-12 items-center justify-center rounded-full bg-tint/10 text-tint">
              <KeyRound className="size-6" aria-hidden />
            </span>
            <div>
              <h2 className="text-title3 text-label">Admin access</h2>
              <p className="mt-1 text-subhead text-label-2">
                Enter the admin token to change platform settings. Changes to the contracts also need the owner wallet.
                {preview ? " In preview any token opens the simulated settings." : ""}
              </p>
            </div>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                unlock();
              }}
            >
              <TextField label="Admin token" type="password" autoComplete="off" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} />
              <Button type="submit" size="lg" disabled={!tokenInput.trim()}>
                Continue
              </Button>
            </form>
          </div>
        </div>
      </>
    );
  }

  const setNumber = (spec: SettingSpec, text: string) => {
    setTexts((existing) => ({ ...existing, [spec.key]: text }));
    const value = fromDisplay(spec, text);
    setDraft((existing) => ({ ...existing, [spec.key]: value }));
  };

  const toggleMode = (mode: FeeMode, on: boolean) =>
    setDraft((existing) => ({ ...existing, enabledModes: on ? [...existing.enabledModes, mode] : existing.enabledModes.filter((entry) => entry !== mode) }));
  const toggleKind = (kind: QuoteKind, on: boolean) =>
    setDraft((existing) => ({ ...existing, enabledQuoteKinds: on ? [...existing.enabledQuoteKinds, kind] : existing.enabledQuoteKinds.filter((entry) => entry !== kind) }));

  const sign = async () => {
    if (!market) return;
    setSigning(true);
    try {
      // Preview simulates the wallet step; live sends one owner transaction per change.
      if (market.kind === "preview") await new Promise((resolve) => setTimeout(resolve, 900));
      await market.updateSettings(draft);
      setReviewing(false);
      setTexts({});
      toast.success("Settings updated", { description: "They apply to coins launched from now on. Existing coins keep their terms." });
    } catch (error) {
      if (error instanceof TxError && error.kind === "rejected") toast("Settings not changed", { description: error.message });
      else toast.error("Settings did not change", { description: error instanceof Error ? error.message : "Try again." });
    } finally {
      setSigning(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" subtitle="Platform settings for new launches. Coins already launched always keep the terms they launched with." />
      <div className="grid grid-cols-1 gap-6 pb-28 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          {GROUPS.map((group) => (
            <section key={group.title} aria-labelledby={`group-${slug(group.title)}`} className="mf-card overflow-hidden">
              <div className="flex items-center justify-between px-5 pb-2 pt-5">
                <h2 id={`group-${slug(group.title)}`} className="text-title3 text-label">
                  {group.title}
                </h2>
                <Badge tone="tint">On-chain</Badge>
              </div>
              <div className="[&>div+div]:hairline-t">
                {group.keys.map((key) => {
                  const spec = SETTING_SPECS.find((entry) => entry.key === key) as SettingSpec;
                  const issue = issues.find((entry) => entry.key === key);
                  const changed = dirtyKeys.includes(key);
                  return (
                    <div key={key} className="grid grid-cols-1 gap-2 px-5 py-4 sm:grid-cols-[1fr_200px] sm:items-center">
                      <div>
                        <p className="flex items-center gap-2 text-body text-label">
                          {spec.label}
                          {changed ? <Badge tone="warning">Changed</Badge> : null}
                        </p>
                        <p className="text-footnote text-label-2">
                          {spec.help} {boundsText(spec)}
                        </p>
                        {issue ? <p className="mt-1 text-footnote text-down">{issue.message}</p> : null}
                      </div>
                      <label className="relative flex items-center">
                        <span className="sr-only">{spec.label}</span>
                        <input
                          inputMode="decimal"
                          value={texts[key] ?? toDisplay(spec, draft[key])}
                          onChange={(event) => setNumber(spec, event.target.value)}
                          className={cn(
                            "mf-num h-11 w-full rounded-sm bg-fill-3 pl-3.5 pr-14 text-right text-body text-label outline-none focus:shadow-[0_0_0_2px_var(--mf-tint)]",
                            issue && "shadow-[0_0_0_2px_var(--mf-down)]",
                          )}
                        />
                        <span className="pointer-events-none absolute right-3.5 text-subhead text-label-2">{unitLabel(spec)}</span>
                      </label>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          <section aria-labelledby="switches" className="mf-card overflow-hidden">
            <div className="flex items-center justify-between px-5 pb-2 pt-5">
              <h2 id="switches" className="text-title3 text-label">
                Availability
              </h2>
              <Badge tone="tint">On-chain</Badge>
            </div>
            <div className="[&>div+div]:hairline-t">
              <SwitchRow
                label="Accept new launches"
                help="Turning this off pauses new launches only. Existing coins keep trading and nobody can stop them."
                checked={!draft.launchesPaused}
                onChange={(on) => setDraft((existing) => ({ ...existing, launchesPaused: !on }))}
              />
              {(Object.keys(MODE_META) as FeeMode[]).map((mode) => (
                <SwitchRow
                  key={mode}
                  label={MODE_META[mode].label}
                  help="Offered as a fee destination for new coins."
                  checked={draft.enabledModes.includes(mode)}
                  onChange={(on) => toggleMode(mode, on)}
                />
              ))}
              <SwitchRow label="ETH pairs" help="New coins can pair with ETH." checked={draft.enabledQuoteKinds.includes("native")} onChange={(on) => toggleKind("native", on)} />
              <SwitchRow label="USDC pairs" help="New coins can pair with USDC." checked={draft.enabledQuoteKinds.includes("stable")} onChange={(on) => toggleKind("stable", on)} />
              <SwitchRow
                label="Tokenized stock pairs"
                help="Keep off on mainnet until the legal review is done. Restricted for US visitors either way."
                checked={draft.enabledQuoteKinds.includes("stock")}
                onChange={(on) => toggleKind("stock", on)}
              />
            </div>
          </section>

          <ModerationSection />
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
          <section className="mf-card flex flex-col gap-3 p-5">
            <span className="flex size-10 items-center justify-center rounded-full bg-up/10 text-up">
              <ShieldCheck className="size-5" aria-hidden />
            </span>
            <h2 className="text-headline text-label">How changes work</h2>
            <ul className="flex flex-col gap-2 text-footnote text-label-2">
              <li>On-chain settings are signed by the owner Safe. This page prepares the calls.</li>
              <li>Every value is capped in the contract, so a mistake here cannot exceed the hard limits.</li>
              <li>Each coin copies these settings when it launches and keeps them forever.</li>
              <li>Hard caps: fee {HARD_CAPS.feeMaxBps / 100}%, platform share {HARD_CAPS.platformShareMaxBps / 100}%, launch protection {HARD_CAPS.snipeStartMaxBps / 100}% for {HARD_CAPS.snipeDurationMaxSec}s.</li>
            </ul>
          </section>
          <section className="mf-card flex flex-col gap-2 p-5 text-footnote text-label-2">
            <p className="text-subhead font-semibold text-label">Owner wallet</p>
            <p className="mf-num break-all">{wallet.address ?? "Not connected"}</p>
            {preview ? <p>Preview: signing updates the simulated market only.</p> : null}
          </section>
        </aside>
      </div>

      {dirtyKeys.length > 0 ? (
        <div className="fixed inset-x-3 z-40 lg:left-[280px]" style={{ bottom: "max(12px, calc(var(--mf-safe-bottom) + 4px))" }}>
          <div className="mf-glass mf-glass-dense mx-auto flex max-w-2xl items-center gap-3 rounded-full p-2 pl-5">
            <p className="flex-1 text-subhead text-label">
              {dirtyKeys.length} {dirtyKeys.length === 1 ? "change" : "changes"}
              {issues.length > 0 ? <span className="text-down">, fix {issues.length} before saving</span> : null}
            </p>
            <Button
              variant="gray"
              size="md"
              className="rounded-full"
              onClick={() => {
                setDraft(current);
                setTexts({});
              }}
            >
              Discard
            </Button>
            <Button size="md" className="rounded-full" disabled={issues.length > 0} onClick={() => setReviewing(true)}>
              Review
            </Button>
          </div>
        </div>
      ) : null}

      <Sheet
        open={reviewing}
        onOpenChange={setReviewing}
        title="Review changes"
        description="These owner calls will be prepared for the Safe. They apply to new launches only."
        footer={
          <Button size="lg" fullWidth loading={signing} loadingLabel="Waiting for owner signature" onClick={() => void sign()}>
            Sign as owner
          </Button>
        }
      >
        <ol className="flex flex-col gap-3">
          {calls.map((call, index) => (
            <li key={`${call.fn}-${index}`} className="rounded-lg bg-fill-4 p-4">
              <p className="text-subhead text-label">{call.summary}</p>
              <p className="mf-num mt-1 break-all font-mono text-footnote text-label-2">
                {call.fn}({call.args.join(", ")})
              </p>
            </li>
          ))}
        </ol>
        {draft.platformShareBps > current.platformShareBps ? (
          <p className="mt-4 flex gap-2 text-footnote text-warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            Raising the platform share lowers what new creators earn. Existing coins are not affected.
          </p>
        ) : null}
      </Sheet>
    </>
  );
}

function SwitchRow({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-body text-label">{label}</p>
        <p className="text-footnote text-label-2">{help}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={label} />
    </div>
  );
}

function ModerationSection() {
  const { market } = useMarket();
  const { coins } = useCoins();
  const moderation = useModeration();
  const [query, setQuery] = useState("");
  const [banner, setBanner] = useState(moderation.banner);
  const all = market?.listCoins(true) ?? coins;
  const save = async (action: () => Promise<void> | undefined, done: string) => {
    try {
      await action();
      toast.success(done);
    } catch (error) {
      toast.error("That did not save", { description: error instanceof Error ? error.message : "Try again." });
    }
  };
  const isFeatured = (address: string) => moderation.featured.some((entry) => entry.toLowerCase() === address.toLowerCase());
  const isHidden = (address: string) => moderation.hidden.some((entry) => entry.toLowerCase() === address.toLowerCase());
  const q = query.trim().toLowerCase();
  const results = all.filter((coin) => !q || coin.name.toLowerCase().includes(q) || coin.symbol.toLowerCase().includes(q) || coin.address.toLowerCase().startsWith(q)).slice(0, 12);

  return (
    <section aria-labelledby="moderation" className="mf-card overflow-hidden">
      <div className="flex items-center justify-between px-5 pb-2 pt-5">
        <h2 id="moderation" className="text-title3 text-label">
          Moderation
        </h2>
        <Badge>Off-chain</Badge>
      </div>
      <p className="px-5 text-footnote text-label-2">Hiding removes a coin from memefun pages only. It keeps trading on chain, because nobody can stop it.</p>
      <div className="flex flex-col gap-3 p-5">
        <TextArea label="Announcement banner" optional rows={2} maxLength={160} showCounter value={banner} onChange={(event) => setBanner(event.target.value)} placeholder="Shown at the top of Discover" />
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="tinted"
            onClick={() => void save(() => market?.setBanner(banner.trim()), banner.trim() ? "Banner published" : "Banner removed")}
          >
            Save banner
          </Button>
        </div>
        <TextField label="Find a coin" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, ticker or address" autoComplete="off" />
      </div>
      <div className="[&>div+div]:hairline-t">
        {results.map((coin) => (
          <div key={coin.address} className="flex items-center gap-3 px-5 py-3">
            <CoinAvatar src={coin.image} alt="" size={36} symbol={coin.symbol} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body text-label">{coin.name}</p>
              <p className="text-footnote text-label-2">${coin.symbol}</p>
            </div>
            <label className="flex items-center gap-2 text-footnote text-label-2">
              Featured
              <Switch checked={isFeatured(coin.address)} onCheckedChange={(on) => void save(() => market?.setFeatured(coin.address, on), on ? `${coin.name} is featured` : `${coin.name} is no longer featured`)} label={`Feature ${coin.name}`} />
            </label>
            <label className="flex items-center gap-2 text-footnote text-label-2">
              Hidden
              <Switch checked={isHidden(coin.address)} onCheckedChange={(on) => void save(() => market?.setHidden(coin.address, on), on ? `${coin.name} is hidden` : `${coin.name} is visible again`)} label={`Hide ${coin.name}`} />
            </label>
          </div>
        ))}
      </div>
    </section>
  );
}

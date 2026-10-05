import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS } from "@/core/settings";
import type { Coin, Claimable } from "@/lib/market/types";
import type { AuthorReward } from "@/lib/create/tweet";
import { EMPTY_DRAFT } from "@/lib/create/draft";
import { ETH } from "@/lib/market/quotes";
import { PreviewMarket } from "@/lib/preview/engine";
import { FeesStep } from "@/components/create/FeesStep";
import { ReviewStep } from "@/components/create/ReviewStep";
import { AuthorRewardCard, AuthorRewardsScreen } from "./AuthorRewardsScreen";
import { RewardsScreen } from "./RewardsScreen";

const view = vi.hoisted(() => ({ coins: [] as Coin[], rewards: [] as AuthorReward[], claimables: [] as Claimable[], treasury: false }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/market/hooks", () => ({
  useCoins: () => ({ coins: view.coins }),
  useCoin: (address?: string) => ({ coin: view.coins.find((coin) => coin.address === address) }),
  useClaimables: () => view.claimables,
}));
vi.mock("@/lib/market/MarketProvider", () => ({ useMarket: () => ({ market: {
  kind: "preview", getAuthorSession: () => ({ authorId: "42", handle: "alice", simulated: true }), getAuthorRewards: () => view.rewards,
  listQuotes: () => [], isAuthorTreasury: () => view.treasury,
} }) }));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ status: "connected", address: "0x00000000000000000000000000000000000000bb", onBase: true }) }));
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ preview: true, txOutcome: "ok" }) }));

const AUTHOR = "0x00000000000000000000000000000000000000bb" as const;
const POOL = `0x${"1".repeat(64)}` as const;
const source = { postId: "123", url: "https://x.com/i/status/123", text: "An idea", author: { id: "42", handle: "alice", name: "Alice" } };
const draft = { ...EMPTY_DRAFT, entry: "tweet" as const, name: "An idea", ticker: "IDEA", tweet: { source, authorShareBps: 5000 } };
const base = new PreviewMarket({ now: Date.UTC(2026, 9, 4), seed: 1 }).listCoins()[0]!;
const tweetCoin: Coin = { ...base, tweet: { postId: "123", authorXUserId: "42", authorShareBps: 5000, treasuryUnlockAt: 1, verifyBy: 1, treasuryUnlocked: true, source } };
const termsCount = (html: string) => [...html.matchAll(/aria-label="Reward terms"/g)].length;
beforeEach(() => { view.coins = []; view.rewards = []; view.claimables = []; view.treasury = false; });

describe("author reward terms and late claim controls", () => {
  it("shows one disclosure on tweet fee and review steps, and none for a manual launch", () => {
    expect(termsCount(renderToStaticMarkup(<FeesStep draft={draft} update={() => undefined} settings={DEFAULT_SETTINGS} errors={{}} showErrors={false} />))).toBe(1);
    expect(termsCount(renderToStaticMarkup(<ReviewStep draft={draft} quote={ETH} settings={DEFAULT_SETTINGS} />))).toBe(1);
    expect(termsCount(renderToStaticMarkup(<FeesStep draft={EMPTY_DRAFT} update={() => undefined} settings={DEFAULT_SETTINGS} errors={{}} showErrors={false} />))).toBe(0);
    expect(termsCount(renderToStaticMarkup(<ReviewStep draft={EMPTY_DRAFT} quote={ETH} settings={DEFAULT_SETTINGS} />))).toBe(0);
  });
  it("shows one coin disclosure regardless of whether the author is already bound", () => {
    expect(termsCount(renderToStaticMarkup(<AuthorRewardCard coin={tweetCoin} />))).toBe(1);
    expect(termsCount(renderToStaticMarkup(<AuthorRewardCard coin={{ ...tweetCoin, tweet: { ...tweetCoin.tweet!, authorWallet: AUTHOR } }} />))).toBe(1);
    expect(renderToStaticMarkup(<AuthorRewardCard coin={base} />)).toBe("");
  });
  it("keeps late binding and late claims enabled while showing terms once for multiple coins", () => {
    const bound: Coin = { ...tweetCoin, address: "0x0000000000000000000000000000000000000123", tweet: { ...tweetCoin.tweet!, authorWallet: AUTHOR, reclaimed: true } };
    view.coins = [tweetCoin, bound];
    view.rewards = [{ coin: bound.address, poolId: POOL, quoteSymbol: "ETH", amountQuote: 0.1, amountUsd: 300 }];
    const html = renderToStaticMarkup(<AuthorRewardsScreen />);
    expect(termsCount(html)).toBe(1);
    const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    for (const action of ["Verify this wallet on chain", "Claim author earnings"]) {
      const button = buttons.find((match) => match[2]!.includes(action));
      expect(button).toBeDefined();
      expect(button![1]).not.toMatch(/\sdisabled(?:=|\s|$)/);
    }
  });
  it("discloses author terms once on the general claim screen whenever an author balance can be claimed", () => {
    view.coins = [tweetCoin];
    const reward = { coin: tweetCoin.address, poolId: POOL, kind: "author" as const, amountQuote: 0.1, quoteSymbol: "ETH", amountUsd: 300 };
    view.claimables = [reward, { ...reward, poolId: `0x${"2".repeat(64)}`, quoteSymbol: "USDC" }];
    expect(termsCount(renderToStaticMarkup(<RewardsScreen />))).toBe(1);
    view.claimables = [{ ...reward, kind: "creator" }];
    expect(termsCount(renderToStaticMarkup(<RewardsScreen />))).toBe(0);
  });
  it("shows treasury controls only for its role, without requiring a matching X identity", () => {
    view.coins = [{ ...tweetCoin, tweet: { ...tweetCoin.tweet!, authorXUserId: "999" } }];
    expect(renderToStaticMarkup(<AuthorRewardsScreen />)).not.toContain('aria-label="Treasury withdrawals"');
    view.treasury = true;
    const html = renderToStaticMarkup(<AuthorRewardsScreen />);
    expect(html).toContain('aria-label="Treasury withdrawals"');
    expect(html).toContain("Check unpaid balances");
    expect(termsCount(html)).toBe(1);
  });
});

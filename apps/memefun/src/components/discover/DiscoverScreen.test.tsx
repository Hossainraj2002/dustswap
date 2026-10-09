/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Coin } from "@/lib/market/types";
import { ETH } from "@/lib/market/quotes";
import { PreviewMarket } from "@/lib/preview/engine";
import { PLATFORM_TOKEN_LAUNCH_AT, PLATFORM_TOKEN_LAUNCHER, type PlatformTokenInfo } from "@/lib/platform-token/config";
import { DiscoverScreen } from "./DiscoverScreen";

const view = vi.hoisted(() => ({ ready: true, coins: [] as Coin[], official: null as Coin | null, requested: undefined as string | undefined,
  available: true, showAnnouncement: true, info: null as PlatformTokenInfo | null }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/hooks", () => ({ useIsRegularWidth: () => true, useLocalStorageState: () => ["grid", vi.fn()] }));
vi.mock("@/lib/market/hooks", () => ({ useCoins: () => ({ coins: view.coins, ready: view.ready }), useModeration: () => ({ banner: "" }),
  useCoin: (address?: string) => { view.requested = address; return { coin: address === view.official?.address ? view.official : undefined }; } }));
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ stocksRestricted: false }) }));
vi.mock("@/lib/platform-token/usePlatformToken", () => ({ usePlatformToken: () => ({ info: view.info, available: view.available, showAnnouncement: view.showAnnouncement }) }));
vi.mock("@/components/rewards/LaunchCampaign", () => ({ LaunchCampaignBanner: () => null }));
vi.mock("@/components/shell/PageHeader", () => ({ PageHeader: () => <h1>Discover</h1> }));
vi.mock("@/components/coin/CoinCard", () => ({ CoinCard: () => null }));
vi.mock("@/components/coin/CoinRow", () => ({ CoinRow: () => null }));
vi.mock("@/components/coin/CoinTable", () => ({ CoinTable: () => null }));
vi.mock("./JustLaunched", () => ({ JustLaunched: () => null }));
vi.mock("./LiveTape", () => ({ LiveTape: () => null }));
vi.mock("./TopCreators", () => ({ TopCreators: () => null }));
vi.mock("./PlatformLaunchCountdown", () => ({ PlatformLaunchCountdown: () => <p>Platform countdown</p> }));
vi.mock("./Spotlight", () => ({ Spotlight: ({ coin, official }: { coin: Coin; official?: boolean }) => <p>{official ? "Official" : "Trending"} hero: {coin.symbol}</p> }));

const seed = new PreviewMarket({ now: 1_800_000_000_000, seed: 1 }).listCoins()[0]!;
const OFFICIAL: Coin = { ...seed, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", symbol: "PLATFORM", quote: ETH, terms: { ...seed.terms, mode: "creator" }, momentum: 1, createdAt: 1 };
const TRENDING: Coin = { ...OFFICIAL, address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", symbol: "TRENDING", momentum: 999 };
const INFO = { enabled: true as const, launchAt: PLATFORM_TOKEN_LAUNCH_AT, launcher: PLATFORM_TOKEN_LAUNCHER, tokenAddress: null };
beforeEach(() => {
  view.ready = true; view.coins = [TRENDING, OFFICIAL]; view.official = null; view.requested = undefined;
  view.available = true; view.showAnnouncement = true; view.info = INFO;
});
afterEach(cleanup);

describe("Discover official platform hero", () => {
  it("replaces the countdown with the pinned token even when another token has more momentum", () => {
    const page = render(<DiscoverScreen />);
    expect(screen.getByText("Platform countdown")).toBeDefined();
    view.info = { ...INFO, tokenAddress: OFFICIAL.address }; view.official = OFFICIAL;
    page.rerender(<DiscoverScreen />);
    expect(screen.queryByText("Platform countdown")).toBeNull();
    expect(screen.getByText("Official hero: PLATFORM")).toBeDefined();
    expect(screen.queryByText("Trending hero: TRENDING")).toBeNull();
  });

  it("withdraws official status during an API outage despite a cached address and indexed coin", () => {
    view.info = { ...INFO, tokenAddress: OFFICIAL.address }; view.official = OFFICIAL;
    const page = render(<DiscoverScreen />);
    expect(screen.getByText("Official hero: PLATFORM")).toBeDefined();
    view.available = false;
    page.rerender(<DiscoverScreen />);
    expect(view.requested).toBeUndefined();
    expect(screen.queryByText("Official hero: PLATFORM")).toBeNull();
    expect(screen.getByText("Platform countdown")).toBeDefined();
  });

  it("keeps the ordinary momentum hero when the live announcement gate is closed", () => {
    view.info = { ...INFO, tokenAddress: OFFICIAL.address }; view.official = OFFICIAL; view.showAnnouncement = false;
    render(<DiscoverScreen />);
    expect(screen.getByText("Trending hero: TRENDING")).toBeDefined();
    expect(screen.queryByText("Official hero: PLATFORM")).toBeNull();
    expect(screen.queryByText("Platform countdown")).toBeNull();
  });

  it.each([true, false])("keeps the announcement visible with no market list (ready=%s)", (ready) => {
    view.coins = []; view.ready = ready;
    render(<DiscoverScreen />);
    expect(screen.getByText("Platform countdown")).toBeDefined();
  });
});

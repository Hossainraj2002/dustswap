import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeeMode } from "@/core/types";
import type { Coin } from "@/lib/market/types";
import { PreviewMarket } from "@/lib/preview/engine";
import { CoinHeader } from "./CoinHeader";

const clock = vi.hoisted(() => ({ now: 0 }));
vi.mock("@/lib/hooks", () => ({ useNow: () => clock.now, useLocalStorageState: () => [[], () => undefined] }));
vi.mock("@/components/shell/WalletButton", () => ({ WalletButton: () => null }));

const launchedAt = Date.UTC(2026, 9, 4);
const seed = new PreviewMarket({ now: launchedAt, seed: 1 }).listCoins()[0]!;
const coin: Coin = { ...seed, createdAt: launchedAt, terms: { ...seed.terms, mode: "creator", feeBps: 500, snipeStartBps: 5000, snipeDurationSec: 60 } };
const render = (value = coin) => renderToStaticMarkup(<CoinHeader coin={value} onShare={() => undefined} />);
beforeEach(() => { clock.now = launchedAt + 30_000; });

describe("current trading fee in the coin header", () => {
  it("makes the hidden compact header inert", () => {
    expect(render()).toMatch(/<div aria-hidden="true" inert=""/);
  });

  it("shows the decaying protection fee instead of the nominal fee, then the normal fee", () => {
    expect(render()).toContain('aria-label="Current trading fee 27.5%"');
    clock.now = launchedAt + 60_000;
    expect(render()).toContain('aria-label="Current trading fee 5%"');
  });

  it("reflects a creator fee reduction, including a zero fee", () => {
    clock.now = launchedAt + 60_000;
    expect(render({ ...coin, terms: { ...coin.terms, feeBps: 125 } })).toContain('aria-label="Current trading fee 1.25%"');
    expect(render({ ...coin, terms: { ...coin.terms, feeBps: 0 } })).toContain('aria-label="Current trading fee 0%"');
  });

  it.each(["creator", "burn", "holders", "floor"] as FeeMode[])("shows the trading fee for %s mode", (mode) => {
    clock.now = launchedAt + 60_000;
    expect(render({ ...coin, terms: { ...coin.terms, mode } })).toContain('aria-label="Current trading fee 5%"');
  });
});

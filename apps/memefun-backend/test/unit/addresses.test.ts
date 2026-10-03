import { describe, expect, it } from "vitest";

import { attributeTrade, indexerAddresses, isExcludedHolder, lc } from "../../lib/indexer/addresses";
import { type Deployment, parseDeployment } from "../../lib/deployment";
import { memefunPoolId, resolveQuote } from "../../lib/market/pool";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;

const deployment: Deployment = parseDeployment({
  chainId: 8453,
  deployedAtBlock: 1,
  poolManager: a(1),
  config: a(2),
  feeVault: a(3),
  factory: a(4),
  router: a(5),
  hook: a(6),
  buybackBurnVault: a(7),
  floorVault: a(8),
  holderRewardDistributor: a(9),
  ethUsdFeed: a(10),
  usdc: a(11),
  owner: a(12),
  treasury: a(13),
  priceKeeper: a(14),
  rewardsPublisher: a(15),
});
const addresses = indexerAddresses(deployment);

describe("trade attribution", () => {
  it("the factory's swap is the creator's first buy", () => {
    expect(attributeTrade(addresses, { sender: a(4), launcher: a(100), txFrom: a(100) })).toEqual({ trader: lc(a(100)), kind: "first_buy" });
  });

  it("the buyback vault's swap is a buyback", () => {
    expect(attributeTrade(addresses, { sender: a(7), launcher: a(100), txFrom: a(200) }).kind).toBe("buyback");
  });

  it("Uniswap's Universal Router trades belong to the transaction sender", () => {
    const universal = "0x6fF5693b99212Da76ad316178A184AB56D299b43";
    expect(attributeTrade(addresses, { sender: universal, launcher: a(100), txFrom: a(300) })).toEqual({ trader: lc(a(300)), kind: "trade" });
  });

  it("MemeFunRouter users are taken as emitted", () => {
    expect(attributeTrade(addresses, { sender: a(400), launcher: a(100), txFrom: a(500) })).toEqual({ trader: lc(a(400)), kind: "trade" });
  });
});

describe("holders", () => {
  it("never counts protocol addresses, dEaD, the zero address or the coin itself", () => {
    const coin = a(999);
    for (const excluded of [a(0), "0x000000000000000000000000000000000000dEaD", a(1), a(3), a(4), a(6), a(7), a(8), a(9), coin]) {
      expect(isExcludedHolder(addresses, coin, excluded), excluded).toBe(true);
    }
    expect(isExcludedHolder(addresses, coin, a(1234))).toBe(false);
  });
});

describe("pool ids", () => {
  const hook = "0x2f0589A0879D9B18fFCd46B0871558E4F5b2Eaec";
  const coin = "0xB2000000000000000000001b03710100DD44768F";

  it("order the currencies, so either argument order gives the same id", () => {
    const usdc = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
    expect(memefunPoolId(coin, usdc, hook)).toBe(memefunPoolId(usdc as `0x${string}`, coin, hook));
  });

  it("resolve a pool's pair asset among the listed quotes", () => {
    const quotes = ["0x0000000000000000000000000000000000000000", "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", "0xB200000000000000000000714f3a595359996d89"] as const;
    for (const quote of quotes) {
      expect(resolveQuote(memefunPoolId(coin, quote, hook), coin, hook, quotes)).toBe(quote);
    }
    expect(resolveQuote(memefunPoolId(coin, a(77), hook), coin, hook, quotes)).toBeNull();
  });
});

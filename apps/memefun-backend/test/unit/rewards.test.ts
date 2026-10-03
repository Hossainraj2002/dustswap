import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress, keccak256, concat } from "viem";
import { describe, expect, it } from "vitest";

import { LEAF_ENCODING, buildRewardTree, leafHash } from "../../lib/rewards/tree";
import { EPOCH_LENGTH_SEC, allocate, latestBoundary, timeWeightedBalances } from "../../lib/rewards/twab";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const POOL = "0x0000000000000000000000000000000000000077";

describe("timeWeightedBalances", () => {
  it("weighs balance by seconds held inside the window", () => {
    const result = timeWeightedBalances({
      startBalances: new Map([[A, 100n]]),
      transfers: [
        { from: POOL, to: B, amount: 50n, timestamp: 1_500 }, // B buys halfway through
        { from: A, to: C, amount: 40n, timestamp: 1_750 }, // A sends some to C
      ],
      windowStart: 1_000,
      windowEnd: 2_000,
      excluded: new Set([POOL]),
    });
    // A: 100 for 750 s, then 60 for 250 s. B: 50 for 500 s. C: 40 for 250 s.
    expect(result.weights.get(A)).toBe(100n * 750n + 60n * 250n);
    expect(result.weights.get(B)).toBe(50n * 500n);
    expect(result.weights.get(C)).toBe(40n * 250n);
    expect(result.weights.has(POOL)).toBe(false);
    expect(result.totalWeight).toBe(90_000n + 25_000n + 10_000n);
    expect(result.endBalances.get(A)).toBe(60n);
  });

  it("gives a holder who held all window the full window, and nothing to someone who sold at the start", () => {
    const result = timeWeightedBalances({
      startBalances: new Map([[A, 10n], [B, 10n]]),
      transfers: [{ from: B, to: POOL, amount: 10n, timestamp: 0 }],
      windowStart: 0,
      windowEnd: EPOCH_LENGTH_SEC,
      excluded: new Set([POOL]),
    });
    expect(result.weights.get(A)).toBe(10n * BigInt(EPOCH_LENGTH_SEC));
    expect(result.weights.has(B)).toBe(false);
  });

  it("refuses transfers outside the window and empty windows", () => {
    const base = { startBalances: new Map<string, bigint>(), excluded: new Set<string>() };
    expect(() => timeWeightedBalances({ ...base, transfers: [{ from: A, to: B, amount: 1n, timestamp: 2_000 }], windowStart: 1_000, windowEnd: 2_000 })).toThrow();
    expect(() => timeWeightedBalances({ ...base, transfers: [], windowStart: 5, windowEnd: 5 })).toThrow();
  });

  it("is case-insensitive on addresses", () => {
    const result = timeWeightedBalances({
      startBalances: new Map([[A, 1n]]),
      transfers: [{ from: A.toUpperCase().replace("0X", "0x"), to: B, amount: 1n, timestamp: 10 }],
      windowStart: 0,
      windowEnd: 20,
      excluded: new Set(),
    });
    expect(result.weights.get(A)).toBe(10n);
    expect(result.weights.get(B)).toBe(10n);
  });
});

describe("allocate", () => {
  it("splits pro rata, rounding down, never over the pot", () => {
    const weights = new Map([[A, 1n], [B, 1n], [C, 1n]]);
    const out = allocate(100n, weights, 1n);
    expect(out).toEqual([
      { account: A, amount: 33n },
      { account: B, amount: 33n },
      { account: C, amount: 33n },
    ]);
    expect(out.reduce((s, x) => s + x.amount, 0n)).toBeLessThanOrEqual(100n);
  });

  it("drops dust and is ordered by account", () => {
    const out = allocate(1_000n, new Map([[C, 998n], [A, 1n], [B, 1n]]), 2n);
    expect(out).toEqual([{ account: C, amount: 998n }]);
    expect(allocate(0n, new Map([[A, 1n]]), 1n)).toEqual([]);
    expect(allocate(10n, new Map(), 1n)).toEqual([]);
  });

  it("the sum never exceeds the pot for random inputs", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31);
    for (let round = 0; round < 200; round += 1) {
      const weights = new Map<string, bigint>();
      for (let i = 0; i < 1 + (rand() % 30); i += 1) weights.set(`0x${(rand() % 1e9).toString(16).padStart(40, "0")}`, BigInt(rand()) * BigInt(rand()));
      const pot = BigInt(rand()) * 10n ** 12n;
      const total = allocate(pot, weights, 1n).reduce((s, x) => s + x.amount, 0n);
      expect(total <= pot).toBe(true);
      expect(pot - total < BigInt(weights.size) + 1n).toBe(true); // floor rounding loses < 1 unit per holder
    }
  });
});

describe("epoch boundaries", () => {
  it("are 00:00 and 12:00 UTC", () => {
    const noon = Date.UTC(2026, 9, 2, 12, 0, 0) / 1000;
    expect(latestBoundary(noon)).toBe(noon);
    expect(latestBoundary(noon + 43_199)).toBe(noon);
    expect(latestBoundary(noon + 43_200)).toBe(noon + 43_200);
    expect(new Date(latestBoundary(noon - 1) * 1000).toISOString()).toBe("2026-10-02T00:00:00.000Z");
  });
});

describe("reward tree", () => {
  const leaves = [
    { epoch: 3n, coin: getAddress("0xb200000000000000000000233ba0DF815CEc70E8"), index: 0n, account: getAddress(A), amount: 123n },
    { epoch: 3n, coin: getAddress("0xb200000000000000000000233ba0DF815CEc70E8"), index: 1n, account: getAddress(B), amount: 456n },
    { epoch: 3n, coin: getAddress("0xB200000000000000000000Fed34484312760f647"), index: 0n, account: getAddress(A), amount: 789n },
  ];

  it("hashes leaves as keccak256(keccak256(abi.encode(...))), the distributor's leaf()", () => {
    const tree = StandardMerkleTree.of(
      leaves.map((l) => [l.epoch.toString(), l.coin, l.index.toString(), l.account, l.amount.toString()]),
      [...LEAF_ENCODING],
    );
    for (const leaf of leaves) {
      expect(leafHash(leaf)).toBe(tree.leafHash([leaf.epoch.toString(), leaf.coin, leaf.index.toString(), leaf.account, leaf.amount.toString()]));
    }
  });

  it("produces proofs that verify against the root", () => {
    const { root, proofs } = buildRewardTree(leaves);
    leaves.forEach((leaf, i) => {
      // Verify the OpenZeppelin way: hash pairs sorted, from the leaf up.
      let node = leafHash(leaf);
      for (const sibling of proofs[i]!) node = keccak256(node.toLowerCase() < sibling.toLowerCase() ? concat([node, sibling]) : concat([sibling, node]));
      expect(node).toBe(root);
    });
  });

  it("refuses an empty epoch", () => {
    expect(() => buildRewardTree([])).toThrow();
  });
});


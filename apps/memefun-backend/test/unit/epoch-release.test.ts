import { describe, expect, it } from "vitest";

import { epochReleaseAccounting } from "../../lib/indexer/epoch-release";

describe("epoch release accounting", () => {
  it("returns the unclaimed reserve to its market without counting paid rewards again", () => {
    const current = { total: 1_000n, claimed: 375n, released: false };
    const result = epochReleaseAccounting(current, 625n)!;
    expect(result.returned + current.claimed).toBe(current.total);
    expect(epochReleaseAccounting({ ...current, ...result }, 625n)).toBeNull();
  });

  it("ignores the zero release event from a registered market omitted from the epoch", () => {
    expect(epochReleaseAccounting(null, 0n)).toBeNull();
    expect(() => epochReleaseAccounting(null, 1n)).toThrow("reserve event is missing");
  });

  it("rejects payouts that disagree with claims already indexed for the reserve", () => {
    const current = { total: 100n, claimed: 25n, released: false };
    expect(() => epochReleaseAccounting(current, 100n)).toThrow("expected unclaimed reserve 75");
    expect(epochReleaseAccounting({ total: 100n, claimed: 100n, released: false }, 0n)).toEqual({ released: true, returned: 0n });
  });
});

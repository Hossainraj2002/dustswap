import { describe, expect, it } from "vitest";

import { epochClaimAccounting } from "../../lib/indexer/epoch-claim";

describe("epoch claim accounting", () => {
  it("counts a zero reserved leaf as claimed while leaving its monetary budget intact", () => {
    const reserved = { total: 100n, claimed: 25n, claims: 2, released: false };
    expect(epochClaimAccounting(reserved, 0n)).toEqual({ claimed: 25n, claims: 3 });
    expect(epochClaimAccounting(reserved, 75n)).toEqual({ claimed: 100n, claims: 3 });
  });

  it("permits an unreserved zero leaf's bitmap event without inventing a reservation", () => {
    expect(epochClaimAccounting(null, 0n)).toBeNull();
    expect(() => epochClaimAccounting(null, 1n)).toThrow("reserve event is missing");
  });

  it("rejects claims that contradict the indexed reserve lifecycle or budget", () => {
    const reserved = { total: 100n, claimed: 25n, claims: 2, released: false };
    expect(() => epochClaimAccounting(reserved, 76n)).toThrow("exceed reserved total");
    expect(() => epochClaimAccounting({ ...reserved, released: true }, 0n)).toThrow("already released");
  });
});

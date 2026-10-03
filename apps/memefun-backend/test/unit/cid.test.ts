import { describe, expect, it } from "vitest";

import { cidV1Raw, isCid, parseIpfsUri } from "../../lib/cid";

describe("cidV1Raw", () => {
  it("matches the CIDs IPFS itself computes for raw blocks", () => {
    // `ipfs add --raw-leaves --cid-version 1` of the empty file and of "hello world".
    expect(cidV1Raw(new Uint8Array())).toBe("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
    expect(cidV1Raw(new TextEncoder().encode("hello world"))).toBe("bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e");
  });

  it("is deterministic and content-sensitive", () => {
    const a = cidV1Raw(new TextEncoder().encode("memefun"));
    expect(cidV1Raw(new TextEncoder().encode("memefun"))).toBe(a);
    expect(cidV1Raw(new TextEncoder().encode("memefun!"))).not.toBe(a);
    expect(isCid(a)).toBe(true);
  });
});

describe("parseIpfsUri", () => {
  const cid = "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e";

  it("accepts ipfs:// with an optional path", () => {
    expect(parseIpfsUri(`ipfs://${cid}`)).toEqual({ cid, path: "" });
    expect(parseIpfsUri(`ipfs://${cid}/meta.json`)).toEqual({ cid, path: "/meta.json" });
    expect(parseIpfsUri(`ipfs://ipfs/${cid}`)).toEqual({ cid, path: "" });
    expect(parseIpfsUri("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")?.cid).toBe("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
  });

  it("rejects everything else", () => {
    for (const uri of ["https://example.com/x.png", `ipfs://not-a-cid`, "ipfs://", `ipns://${cid}`, `ipfs://${cid}?x=1`, "javascript:alert(1)"]) {
      expect(parseIpfsUri(uri), uri).toBeNull();
    }
  });
});

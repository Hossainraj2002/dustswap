import { describe, expect, it } from "vitest";
import { mediaImageUrl } from "./media-url";

const CID = "bafkreigz6vox5dempm45jvowv43et2gpu25ml3lss6lx6ytct6nhzgrmna";
const OLD = `https://memefun-api-production.up.railway.app/media/${CID}`;
const CDN = "https://memefun-api.dustswap.wtf";

describe("immutable media rendering", () => {
  it("renders old API uploads through the configured CDN alias", () => {
    expect(mediaImageUrl(OLD, CDN + "/")).toBe(`${CDN}/media/${CID}`);
  });

  it("can restore the original origin by restoring the API configuration", () => {
    expect(mediaImageUrl(OLD, "https://memefun-api-production.up.railway.app")).toBe(OLD);
    expect(mediaImageUrl(OLD, "")).toBe(OLD);
  });

  it.each([
    `https://memefun-api-production.up.railway.app.evil.test/media/${CID}`,
    `https://other.up.railway.app/media/${CID}`,
    "https://memefun-api-production.up.railway.app/v1/coins",
    "https://memefun-api-production.up.railway.app/media/not-a-cid",
    `https://user:secret@memefun-api-production.up.railway.app/media/${CID}`,
    "data:image/png;base64,AA==", "/pair-icons/eth.svg", undefined,
  ])("leaves third-party, nonmedia, invalid and local image sources unchanged: %s", value => {
    expect(mediaImageUrl(value, CDN)).toBe(value);
  });

  it.each(["javascript:alert(1)", "https://user:secret@example.com", "https://api.test?token=secret", "not-a-url"])
    ("ignores invalid API configuration %s", target => {
      expect(mediaImageUrl(OLD, target)).toBe(OLD);
    });
});

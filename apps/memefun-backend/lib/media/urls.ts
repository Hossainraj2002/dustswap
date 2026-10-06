import { isCid, parseIpfsUri } from "../cid";
import type { MediaStore } from "./store";

/** An exact, credential-free public bucket URL small enough for the factory's metadata URI. */
export function publicBucketUrl(media: MediaStore, cid: string, value = media.urlFor(cid)): string | null {
  if (!isCid(cid)) return null;
  try {
    const url = new URL(value);
    const expected = new URL(media.urlFor(cid));
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.endsWith(`/media/${cid}`) && url.toString() === expected.toString() && url.toString().length <= 256) return url.toString();
  } catch { /* Unusable public configuration cannot become an immutable onchain reference. */ }
  return null;
}

/** API metadata lookup: IPFS compatibility, or this bucket's exact authenticated CID URL. */
export function storedMetadataCid(uri: string, media: MediaStore): string | null {
  const ipfs = parseIpfsUri(uri);
  if (ipfs) return ipfs.cid;
  if (media.kind !== "bucket") return null;
  try {
    const url = new URL(uri);
    const cid = url.pathname.split("/").at(-1) ?? "";
    return publicBucketUrl(media, cid, uri) ? cid : null;
  } catch {
    return null;
  }
}

import { createHash } from "node:crypto";
import { isCid } from "./public-delivery-policy.mjs";

export { isCid };

/**
 * IPFS content identifiers for the local media store: CIDv1, raw codec, sha2-256, base32. The
 * same bytes always get the same CID, exactly as IPFS computes it for a raw block, so
 * `ipfs://<cid>` means the same thing locally and on IPFS.
 */

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const CID_V1 = 0x01;
const RAW_CODEC = 0x55;
const SHA2_256 = 0x12;

function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function cidV1Raw(bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest();
  const cid = new Uint8Array(4 + digest.length);
  cid.set([CID_V1, RAW_CODEC, SHA2_256, digest.length]);
  cid.set(digest, 4);
  return `b${base32(cid)}`;
}

/** `ipfs://<cid>` or `ipfs://<cid>/<path>`; returns null for anything else. */
export function parseIpfsUri(uri: string): { cid: string; path: string } | null {
  const match = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)((?:\/[^?#]*)?)$/.exec(uri.trim());
  if (!match?.[1] || !isCid(match[1])) return null;
  return { cid: match[1], path: match[2] ?? "" };
}

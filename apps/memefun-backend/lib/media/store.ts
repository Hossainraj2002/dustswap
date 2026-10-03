/**
 * Where coin images and metadata live. Every object is content-addressed: `put` returns the IPFS
 * CID of the bytes it stored, and the on-chain contractURI is `ipfs://<cid>`.
 *
 *   LocalMediaStore  : files under data/media, CIDs computed locally (dev and tests)
 *   Pinata + R2      : pinned to IPFS through Pinata, mirrored to R2 for fast reads (Phase 4)
 */
export interface StoredObject {
  cid: string;
  /** `ipfs://<cid>`: what goes on chain and into metadata. */
  uri: string;
  /** HTTPS URL the app loads the object from. */
  url: string;
  bytes: number;
  contentType: string;
}

export interface MediaObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface MediaStore {
  readonly kind: string;
  put(bytes: Uint8Array, contentType: string): Promise<StoredObject>;
  /** The object for a CID, or null when this store does not have it. */
  get(cid: string): Promise<MediaObject | null>;
  /** Public HTTPS URL for a CID (whether or not this store holds it). */
  urlFor(cid: string): string;
}

/** Content types the store accepts: the re-encoded image format and metadata JSON. */
export const STORABLE_TYPES = new Set(["image/webp", "application/json"]);

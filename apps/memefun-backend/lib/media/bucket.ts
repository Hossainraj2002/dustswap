import { cidV1Raw, isCid } from "../cid";
import type { ObjectBucket } from "./remote";
import { type MediaObject, type MediaStore, STORABLE_TYPES, type StoredObject } from "./store";

/**
 * Media in one private S3-compatible bucket (a Railway storage bucket on the testnet), shared by
 * the API and the keeper. Like the local store, CIDs are computed here and every read is re-hashed,
 * so a tampered object is never served; the API serves objects at /media/<cid>. Nothing is pinned
 * to IPFS, so `ipfs://` URIs resolve through this API only: fine for a testnet, and Pinata + R2
 * (remote.ts) is the mainnet store.
 */
export class BucketMediaStore implements MediaStore {
  readonly kind = "bucket";

  constructor(
    private readonly bucket: ObjectBucket,
    private readonly publicBaseUrl: string,
  ) {}

  async put(bytes: Uint8Array, contentType: string): Promise<StoredObject> {
    if (!STORABLE_TYPES.has(contentType)) throw new Error(`unsupported content type ${contentType}`);
    const cid = cidV1Raw(bytes);
    await this.bucket.put(cid, bytes, contentType);
    return { cid, uri: `ipfs://${cid}`, url: this.urlFor(cid), bytes: bytes.byteLength, contentType };
  }

  async get(cid: string): Promise<MediaObject | null> {
    if (!isCid(cid)) return null;
    const object = await this.bucket.get(cid);
    if (!object || cidV1Raw(object.bytes) !== cid) return null;
    return object;
  }

  urlFor(cid: string): string {
    return `${this.publicBaseUrl.replace(/\/$/, "")}/media/${cid}`;
  }
}

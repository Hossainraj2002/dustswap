import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { isCid } from "../cid";
import { type MediaObject, type MediaStore, STORABLE_TYPES, type StoredObject } from "./store";

/**
 * Production media (Phase 4): every object is pinned to IPFS through Pinata, which returns its CID,
 * then the same bytes are written to an R2 bucket under that CID so the app reads them from our
 * own domain at CDN speed. IPFS keeps the content verifiable and independent of us; R2 keeps it
 * fast. Reads try R2 first and fall back to the Pinata gateway.
 */
export interface PinataR2Config {
  pinataJwt: string;
  /** Pinata dedicated gateway host, e.g. "example.mypinata.cloud". */
  pinataGateway: string;
  r2: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  /** Public base URL of the bucket, e.g. "https://media.memefun.dustswap.wtf". */
  publicUrl: string;
}

export interface ObjectBucket {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<MediaObject | null>;
}

export function r2Bucket(config: PinataR2Config["r2"]): ObjectBucket {
  return s3Bucket({
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    region: "auto",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
  });
}

/** Any S3-compatible bucket: Cloudflare R2, or a Railway storage bucket (virtual-hosted URLs). */
export function s3Bucket(config: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string }): ObjectBucket {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return {
    async put(key, bytes, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: "public, max-age=31536000, immutable" }),
      );
    },
    async get(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        if (!object.Body) return null;
        return { bytes: await object.Body.transformToByteArray(), contentType: object.ContentType ?? "application/octet-stream" };
      } catch {
        return null;
      }
    },
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class PinataR2MediaStore implements MediaStore {
  readonly kind = "pinata+r2";

  constructor(
    private readonly config: Pick<PinataR2Config, "pinataJwt" | "pinataGateway" | "publicUrl">,
    private readonly bucket: ObjectBucket,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  async put(bytes: Uint8Array, contentType: string): Promise<StoredObject> {
    if (!STORABLE_TYPES.has(contentType)) throw new Error(`unsupported content type ${contentType}`);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: contentType }), contentType === "application/json" ? "metadata.json" : "image.webp");
    form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
    const response = await this.fetchFn("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.pinataJwt}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Pinata pin failed: HTTP ${response.status}`);
    const body = (await response.json()) as { IpfsHash?: string };
    const cid = body.IpfsHash;
    if (!cid || !isCid(cid)) throw new Error("Pinata returned no valid CID");
    await this.bucket.put(cid, bytes, contentType);
    return { cid, uri: `ipfs://${cid}`, url: this.urlFor(cid), bytes: bytes.byteLength, contentType };
  }

  async get(cid: string): Promise<MediaObject | null> {
    if (!isCid(cid)) return null;
    const mirrored = await this.bucket.get(cid);
    if (mirrored) return mirrored;
    try {
      const response = await this.fetchFn(`https://${this.config.pinataGateway}/ipfs/${cid}`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
      return { bytes: new Uint8Array(await response.arrayBuffer()), contentType };
    } catch {
      return null;
    }
  }

  urlFor(cid: string): string {
    return `${this.config.publicUrl.replace(/\/$/, "")}/${cid}`;
  }
}

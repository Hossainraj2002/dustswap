import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { cidV1Raw, isCid } from "../cid";
import { type MediaObject, type MediaStore, STORABLE_TYPES, type StoredObject } from "./store";

/**
 * Media on the local disk, for development and tests: `<dir>/<cid>` holds the bytes and
 * `<dir>/<cid>.type` the content type. Reads re-hash the bytes, so a tampered file is never served.
 */
export class LocalMediaStore implements MediaStore {
  readonly kind = "local";
  private readonly dir: string;

  constructor(
    dir: string,
    private readonly publicBaseUrl: string,
  ) {
    this.dir = resolve(dir);
  }

  async put(bytes: Uint8Array, contentType: string): Promise<StoredObject> {
    if (!STORABLE_TYPES.has(contentType)) throw new Error(`unsupported content type ${contentType}`);
    const cid = cidV1Raw(bytes);
    await mkdir(this.dir, { recursive: true });
    // Write-then-rename so a concurrent reader never sees a half-written object.
    const tmp = join(this.dir, `.${cid}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, bytes);
    await writeFile(join(this.dir, `${cid}.type`), contentType);
    await rename(tmp, join(this.dir, cid));
    return { cid, uri: `ipfs://${cid}`, url: this.urlFor(cid), bytes: bytes.byteLength, contentType };
  }

  async get(cid: string): Promise<MediaObject | null> {
    if (!isCid(cid)) return null;
    try {
      const [bytes, contentType] = await Promise.all([
        readFile(join(this.dir, cid)),
        readFile(join(this.dir, `${cid}.type`), "utf8"),
      ]);
      if (cidV1Raw(bytes) !== cid) return null;
      return { bytes: new Uint8Array(bytes), contentType: contentType.trim() };
    } catch {
      return null;
    }
  }

  urlFor(cid: string): string {
    return `${this.publicBaseUrl.replace(/\/$/, "")}/media/${cid}`;
  }
}

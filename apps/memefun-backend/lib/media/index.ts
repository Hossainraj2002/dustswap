import { resolve } from "node:path";

import { optionalEnv, requireEnv } from "../env";
import { LocalMediaStore } from "./local";
import { PinataR2MediaStore, r2Bucket } from "./remote";
import type { MediaStore } from "./store";

/** MEDIA_STORE=local (default; files under MEDIA_LOCAL_DIR) or pinata (Pinata pin + R2 mirror). */
export function createMediaStore(): MediaStore {
  const kind = optionalEnv("MEDIA_STORE") ?? "local";
  if (kind === "local") {
    return new LocalMediaStore(resolve(optionalEnv("MEDIA_LOCAL_DIR") ?? "./data/media"), optionalEnv("PUBLIC_API_URL") ?? "http://localhost:42069");
  }
  if (kind === "pinata") {
    return new PinataR2MediaStore(
      { pinataJwt: requireEnv("PINATA_JWT"), pinataGateway: requireEnv("PINATA_GATEWAY"), publicUrl: requireEnv("R2_PUBLIC_URL") },
      r2Bucket({
        accountId: requireEnv("R2_ACCOUNT_ID"),
        accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
        bucket: requireEnv("R2_BUCKET"),
      }),
    );
  }
  throw new Error(`MEDIA_STORE must be local or pinata, got "${kind}".`);
}

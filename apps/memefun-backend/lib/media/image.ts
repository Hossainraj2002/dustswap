import sharp from "sharp";

import { IMAGE_MAX_BYTES } from "../../shared/core/validation";

/**
 * Coin images: whatever is uploaded, what we store is a fresh 512 x 512 WebP that we encoded
 * ourselves. Re-encoding drops EXIF and GPS data, colour-profile tricks, appended payloads and
 * every frame after the first, so the stored file holds pixels and nothing else.
 */
export const IMAGE_SIZE_PX = 512;
/** Decompression-bomb guard: refuse inputs above this many pixels before decoding them. */
const MAX_INPUT_PIXELS = 40_000_000;

export type SniffedImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export class ImageRejected extends Error {}

/** The real format from the file's first bytes; the declared content type is never trusted. */
export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return "image/gif";
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

export async function processCoinImage(bytes: Uint8Array): Promise<{ webp: Uint8Array; sourceType: SniffedImageType }> {
  if (bytes.byteLength === 0) throw new ImageRejected("The image is empty.");
  if (bytes.byteLength > IMAGE_MAX_BYTES) throw new ImageRejected("Use an image under 4 MB.");
  const sourceType = sniffImageType(bytes);
  if (!sourceType) throw new ImageRejected("Use a PNG, JPG, WebP or GIF image.");

  try {
    const pipeline = sharp(bytes, { animated: false, limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
    const meta = await pipeline.metadata();
    if (!meta.width || !meta.height) throw new ImageRejected("The image could not be read.");
    if (meta.width < 64 || meta.height < 64) throw new ImageRejected("Use an image at least 64 pixels wide and tall.");
    const webp = await pipeline
      .rotate() // honour the EXIF orientation before it is discarded
      .resize(IMAGE_SIZE_PX, IMAGE_SIZE_PX, { fit: "cover", position: "attention" })
      .webp({ quality: 86, effort: 4 })
      .toBuffer();
    return { webp: new Uint8Array(webp), sourceType };
  } catch (error) {
    if (error instanceof ImageRejected) throw error;
    throw new ImageRejected("The image could not be read. Try a different file.");
  }
}

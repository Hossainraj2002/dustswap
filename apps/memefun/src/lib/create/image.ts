/**
 * Normalizes a coin image in the browser: center-crops to a square, scales to
 * 512px and re-encodes as WebP. Re-encoding drops EXIF metadata (phone GPS
 * location, camera details) before anything leaves the device. The API
 * re-encodes again server-side in Phase 3; this is the first line.
 */
export async function normalizeCoinImage(file: File, size = 512): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side < 64) throw new Error("Use an image at least 64 pixels on each side.");
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    const target = Math.min(size, side);
    const canvas = document.createElement("canvas");
    canvas.width = target;
    canvas.height = target;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not read this image.");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, target, target);
    const webp = canvas.toDataURL("image/webp", 0.9);
    // Safari before 14 cannot encode WebP and silently returns PNG; both are fine.
    return webp;
  } finally {
    bitmap.close();
  }
}

/** Package the supplied logo without redrawing or removing its background. */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Next already ships Sharp; this asset task needs no additional dependency.
const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve("next/package.json"))("sharp");
const source = await readFile(new URL("../assets/branding/memefun-logo-source.png", import.meta.url));
const publicPath = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));
const png = (size) => sharp(source).resize(size, size, { fit: "contain" }).png({ compressionLevel: 9 }).toBuffer();

await Promise.all([
  ["memefun-logo.png", 256], ["icon-32.png", 32], ["icon-192.png", 192],
  ["icon-512.png", 512], ["apple-touch-icon.png", 180],
].map(async ([name, size]) => writeFile(publicPath(name), await png(size))));

// Inset the artwork so the cube stays inside the central maskable safe area.
const maskable = await sharp({ create: { width: 512, height: 512, channels: 3, background: "#96dcf7" } })
  .composite([{ input: await png(320), left: 96, top: 96 }]).png({ compressionLevel: 9 }).toBuffer();
await writeFile(publicPath("icon-maskable-512.png"), maskable);

// Retain the existing SVG URL for installed clients, using the same supplied image.
const icon = await png(192);
await writeFile(publicPath("icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><image width="192" height="192" href="data:image/png;base64,${icon.toString("base64")}"/></svg>\n`);

// This opaque tile covers only the old brand mark; the rest of the card is unchanged.
const social = await sharp(await readFile(publicPath("og.png")))
  .composite([{ input: await png(64), left: 80, top: 72 }]).png({ compressionLevel: 9 }).toBuffer();
await writeFile(publicPath("og.png"), social);

console.log("MemeFun logo, favicon, app icons, wallet icon and social card packaged.");

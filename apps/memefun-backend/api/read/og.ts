import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import type { Hono } from "hono";
import satori from "satori";
import sharp from "sharp";

import { parseIpfsUri } from "../../lib/cid";
import type { MediaStore } from "../../lib/media/store";
import { formatCompact, formatPercent, formatUsd, shortAddress } from "../../shared/core/format";
import { milestoneLabel } from "../../shared/core/milestones";
import type { Coin } from "../../shared/market-types";
import { HttpError, parseAddress } from "../http";
import { creatorProfiles } from "./routes";
import type { MarketSnapshot } from "./snapshot";

/**
 * Share cards (1200 x 630 PNG) for X, Telegram and Farcaster previews: a coin, a fresh launch, a
 * milestone, a creator. Rendered with satori (layout to SVG) and resvg (SVG to PNG), cached for a
 * minute per card.
 */
const WIDTH = 1200;
const HEIGHT = 630;
const BLUE = "#0052FF";
const INK = "#0B0B0F";
const MUTED = "#6B6B76";
const UP = "#0A8F3C";
const DOWN = "#C8102E";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const font = (weight: number) => readFileSync(join(root, "node_modules/@fontsource/inter/files", `inter-latin-${weight}-normal.woff`));
let fonts: Array<{ name: string; data: Buffer; weight: 400 | 600 | 800; style: "normal" }> | null = null;
function loadFonts() {
  fonts ??= [
    { name: "Inter", data: font(400), weight: 400, style: "normal" },
    { name: "Inter", data: font(600), weight: 600, style: "normal" },
    { name: "Inter", data: font(800), weight: 800, style: "normal" },
  ];
  return fonts;
}

type Node = { type: string; props: Record<string, unknown> & { children?: unknown } };
const h = (type: string, style: Record<string, unknown>, ...children: unknown[]): Node => ({
  type,
  props: { style: { display: "flex", ...style }, children: children.length === 1 ? children[0] : children },
});

/** Plain decimals for card prices: the subscript notation needs glyphs the card font lacks. */
export function plainUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value >= 0.01) return formatUsd(value, { compact: true });
  const zeros = -Math.floor(Math.log10(value)) - 1;
  return `$${value.toFixed(Math.min(zeros + 3, 20)).replace(/0+$/, "")}`;
}

const MODE_LINE: Record<Coin["terms"]["mode"], string> = {
  creator: "Fees go to the creator",
  burn: "Fees buy back and burn",
  holders: "Fees pay holders twice a day",
  floor: "Fees build a price floor",
};

async function coinImage(coin: Coin, media: MediaStore): Promise<string | null> {
  const match = /\/media\/([a-z2-7]+)$/i.exec(coin.image) ?? (parseIpfsUri(coin.image) ? [coin.image, parseIpfsUri(coin.image)!.cid] : null);
  if (!match?.[1]) return null;
  const object = await media.get(match[1]);
  if (!object) return null;
  const png = await sharp(object.bytes).resize(220, 220).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

function avatar(coin: Coin, image: string | null): Node {
  if (image) return { type: "img", props: { src: image, width: 200, height: 200, style: { borderRadius: 100 } } };
  return h(
    "div",
    { width: 200, height: 200, borderRadius: 100, background: BLUE, color: "white", fontSize: 72, fontWeight: 800, alignItems: "center", justifyContent: "center" },
    coin.symbol.slice(0, 2),
  );
}

function frame(content: Node, badge: string): Node {
  return h(
    "div",
    { width: WIDTH, height: HEIGHT, background: "#FFFFFF", flexDirection: "column", padding: 64, fontFamily: "Inter", color: INK, justifyContent: "space-between" },
    content,
    h(
      "div",
      { alignItems: "center", justifyContent: "space-between", width: "100%" },
      h("div", { background: BLUE, color: "white", borderRadius: 999, padding: "10px 24px", fontSize: 28, fontWeight: 600 }, badge),
      h("div", { fontSize: 30, fontWeight: 600, color: MUTED }, "memefun.dustswap.wtf"),
    ),
  );
}

function stat(label: string, value: string, color = INK): Node {
  return h("div", { flexDirection: "column", marginRight: 64 }, h("div", { fontSize: 26, color: MUTED }, label), h("div", { fontSize: 52, fontWeight: 800, color }, value));
}

export function coinCard(coin: Coin, image: string | null, variant: { kind: "coin" | "launch" } | { kind: "milestone"; level: number }): Node {
  const header = h(
    "div",
    { alignItems: "center" },
    avatar(coin, image),
    h(
      "div",
      { flexDirection: "column", marginLeft: 40, maxWidth: 820 },
      h("div", { fontSize: 72, fontWeight: 800, lineHeight: 1.05 }, coin.name),
      h("div", { fontSize: 34, color: MUTED, marginTop: 8 }, `$${coin.symbol} paired with ${coin.quote.symbol}`),
    ),
  );
  if (variant.kind === "milestone") {
    return frame(
      h(
        "div",
        { flexDirection: "column" },
        header,
        h("div", { fontSize: 96, fontWeight: 800, color: BLUE, marginTop: 48 }, `${milestoneLabel(variant.level)} market cap`),
      ),
      "Milestone reached",
    );
  }
  const change = coin.change24h;
  return frame(
    h(
      "div",
      { flexDirection: "column" },
      header,
      h(
        "div",
        { marginTop: 56 },
        stat("Market cap", formatUsd(coin.marketCapUsd, { compact: true })),
        stat("Price", plainUsd(coin.priceUsd)),
        variant.kind === "launch" ? stat("Fee", `${coin.terms.feeBps / 100}%`) : stat("24h", formatPercent(change, { signed: true }), change >= 0 ? UP : DOWN),
      ),
    ),
    variant.kind === "launch" ? "Just launched" : MODE_LINE[coin.terms.mode],
  );
}

export function profileCard(address: string, coins: number, volumeUsd: number): Node {
  return frame(
    h(
      "div",
      { flexDirection: "column" },
      h("div", { fontSize: 34, color: MUTED }, "Creator on memefun"),
      h("div", { fontSize: 76, fontWeight: 800, marginTop: 12 }, shortAddress(address)),
      h("div", { marginTop: 56 }, stat("Coins launched", String(coins)), stat("Volume", `$${formatCompact(volumeUsd)}`)),
    ),
    "Launch yours",
  );
}

export async function renderPng(node: Node): Promise<Buffer> {
  const svg = await satori(node as never, { width: WIDTH, height: HEIGHT, fonts: loadFonts() });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } }).render().asPng());
}

export function mountOg(app: Hono, deps: { snapshot: MarketSnapshot; media: MediaStore }) {
  const cache = new Map<string, { at: number; png: Buffer }>();
  const TTL = 60_000;

  const respond = async (key: string, build: () => Promise<Node>) => {
    const hit = cache.get(key);
    let png = hit && Date.now() - hit.at < TTL ? hit.png : null;
    if (!png) {
      png = await renderPng(await build());
      if (cache.size > 2_000) cache.clear();
      cache.set(key, { at: Date.now(), png });
    }
    return new Response(new Uint8Array(png), {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
    });
  };

  const coinFor = async (raw: string | undefined) => {
    const state = await deps.snapshot.ready();
    const coin = state.byAddress.get(parseAddress((raw ?? "").replace(/\.png$/, "")));
    if (!coin || coin.hidden) throw new HttpError(404, "coin_not_found", "No coin with this address on memefun.");
    return coin;
  };

  app.get("/og/coin/:address", async (c) => {
    const coin = await coinFor(c.req.param("address"));
    return respond(`coin:${coin.address}`, async () => coinCard(coin, await coinImage(coin, deps.media), { kind: "coin" }));
  });

  app.get("/og/launch/:address", async (c) => {
    const coin = await coinFor(c.req.param("address"));
    return respond(`launch:${coin.address}`, async () => coinCard(coin, await coinImage(coin, deps.media), { kind: "launch" }));
  });

  app.get("/og/milestone/:address/:level", async (c) => {
    const coin = await coinFor(c.req.param("address"));
    const level = Number((c.req.param("level") ?? "").replace(/\.png$/, ""));
    if (!Number.isInteger(level) || level <= 0 || coin.athMarketCapUsd < level) {
      throw new HttpError(404, "milestone_not_reached", "This coin has not reached that milestone.");
    }
    return respond(`milestone:${coin.address}:${level}`, async () => coinCard(coin, await coinImage(coin, deps.media), { kind: "milestone", level }));
  });

  app.get("/og/profile/:address", async (c) => {
    const state = await deps.snapshot.ready();
    const address = parseAddress((c.req.param("address") ?? "").replace(/\.png$/, ""));
    const profile = creatorProfiles(state).find((p) => p.address.toLowerCase() === address);
    return respond(`profile:${address}`, async () => profileCard(profile?.address ?? address, profile?.coins.length ?? 0, profile?.volumeUsd ?? 0));
  });
}

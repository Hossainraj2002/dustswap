import type { MetadataRoute } from "next";

/** Installable as a home-screen app (standalone, safe-area aware). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "memefun",
    short_name: "memefun",
    description: "Launch and trade meme coins on Base. Fixed supply, no admin keys, liquidity locked forever.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#000000",
    theme_color: "#0052FF",
    categories: ["finance", "social"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

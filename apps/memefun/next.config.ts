import type { NextConfig } from "next";

const apiOrigin = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001")
  .trim()
  .replace(/\/+$/, "")
  .replace(/\/api$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The dev build indicator sits where the floating tab bar lives.
  devIndicators: { buildActivity: false, appIsrStatus: false },
  images: {
    // Coin images are user content served from our own media domain (Phase 3)
    // or generated SVG in preview, so they render through plain <img>.
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Coinbase / Base Account sign-in opens a popup that must be able to
          // talk back to this window.
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  async rewrites() {
    // Same-origin API: in-app wallet browsers and ad blockers drop
    // third-party requests, so the browser only ever talks to this host.
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
  webpack: (config) => {
    // wagmi / WalletConnect pull optional Node-only deps that the browser
    // bundle never needs.
    config.externals = [...(config.externals || []), "pino-pretty", "lokijs", "encoding"];
    // Privy optionally imports a Solana-only Farcaster module. memefun is
    // EVM-only (walletChainType "ethereum-only"), so it resolves to nothing.
    config.resolve.alias = { ...(config.resolve.alias || {}), "@farcaster/mini-app-solana": false };
    return config;
  },
};

export default nextConfig;

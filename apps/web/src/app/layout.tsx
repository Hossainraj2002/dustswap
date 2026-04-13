import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Providers } from "./providers";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const siteUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.dustswap.wtf";
const siteTitle = "DustSwap | Swap, quests, and progress on Base";
const siteDescription =
  "DustSwap combines swapping, quests, streaks, referrals, and leaderboard progress into one Base-first app.";
const siteOgImage = `${siteUrl}/og.png`;
const siteLogo = `${siteUrl}/logo.png`;
const baseEmbed = JSON.stringify({
  version: "1",
  imageUrl: siteOgImage,
  button: {
    title: "Open Dustswap",
    action: {
      type: "launch_frame",
      name: "Dustswap",
      url: siteUrl,
      splashImageUrl: siteLogo,
      splashBackgroundColor: "#030305",
    },
  },
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: "Dustswap",
  title: siteTitle,
  description: siteDescription,
  keywords: ["DustSwap", "Swap", "Bridge", "Cross-chain", "Base"],
  authors: [{ name: "DustSwap Team" }],
  openGraph: {
    title: siteTitle,
    description: siteDescription,
    url: siteUrl,
    siteName: "Dustswap",
    images: [
      {
        url: "/og.png",
        alt: "Dustswap - Made defi fun",
        width: 1200,
        height: 628,
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: siteTitle,
    description: siteDescription,
    images: ["/og.png"],
  },
  icons: {
    icon: "/logo.png",
  },
  other: {
    "base:app_id": "6992d2eae0d5d2cf831b5db6",
    "fc:miniapp": baseEmbed,
    "fc:frame": baseEmbed,
    "talentapp:project_verification":
      "e88e47328a568a737d6e72f1e0603703a0b9af09f56f7cd67ce4cce5c4bf0ae1dc639c4aa5a9644a06c5e0c3f93e41637edf05f3bab1db80201c71ebf3afb86a",
  },
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#eef4fb",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-[#eef3f8] font-sans text-slate-900 antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
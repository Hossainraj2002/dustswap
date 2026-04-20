import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const siteUrl = "https://dustswap.wtf";
const siteTitle = "DustSwap | A better daily DeFi experience on Base";
const siteDescription =
  "DustSwap combines swapping, progression, rewards, and daily engagement into one Base-first product built for active onchain users.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: "DustSwap",
  title: siteTitle,
  description: siteDescription,
  keywords: ["DustSwap", "Base", "DeFi", "Swap", "Bridge", "Quests"],
  authors: [{ name: "DustSwap Team" }],
  openGraph: {
    title: siteTitle,
    description: siteDescription,
    url: siteUrl,
    siteName: "DustSwap",
    images: [
      {
        url: "/marketing/og-home.png",
        alt: "DustSwap marketing homepage",
        width: 1200,
        height: 630,
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: siteTitle,
    description: siteDescription,
    images: ["/marketing/og-home.png"],
  },
  icons: {
    icon: "/brand/logo.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f6f9fd",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}

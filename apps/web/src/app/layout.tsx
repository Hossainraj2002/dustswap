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

export const metadata: Metadata = {
  title: {
    default: "DustSwap",
    template: "%s | DustSwap",
  },
  description: "Sweep your dust tokens into value",
  applicationName: "DustSwap",
  keywords: [
    "DustSwap",
    "dust tokens",
    "DEX aggregator",
    "Base",
    "swap",
    "batch swap",
    "MiniApp",
  ],
  authors: [{ name: "DustSwap Team" }],
  creator: "DustSwap",
  openGraph: {
    type: "website",
    locale: "en_US",
    title: "DustSwap",
    description: "Sweep your dust tokens into value",
    siteName: "DustSwap",
  },
  twitter: {
    card: "summary_large_image",
    title: "DustSwap",
    description: "Sweep your dust tokens into value",
  },
  other: {
    "fc:frame": "vNext",
    "base:app_id": "6992d2eae0d5d2cf831b5db6",
  },
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#030305",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} dark`} suppressHydrationWarning>
      <body className="min-h-screen bg-[#030305] font-sans text-white antialiased">
        <Providers>
          {/* Ambient background glow effects */}
          <div
            className="ambient-glow ambient-glow--purple"
            aria-hidden="true"
          />
          <div
            className="ambient-glow ambient-glow--blue"
            aria-hidden="true"
          />

          {/* Floating dust particles */}
          <div className="dust-particles" aria-hidden="true">
            <div className="dust-particle dust-particle--1" />
            <div className="dust-particle dust-particle--2" />
            <div className="dust-particle dust-particle--3" />
            <div className="dust-particle dust-particle--4" />
            <div className="dust-particle dust-particle--5" />
            <div className="dust-particle dust-particle--6" />
            <div className="dust-particle dust-particle--7" />
            <div className="dust-particle dust-particle--8" />
          </div>

          {/* App shell */}
          <div className="relative z-10">
            <AppShell>{children}</AppShell>
          </div>
        </Providers>
      </body>
    </html>
  );
}
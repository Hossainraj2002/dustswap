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
  title: "DustSwap - Cross-Chain Swaps",
  description: "Swap and bridge tokens across chains with zero gas fees",
  keywords: ["DustSwap", "Swap", "Bridge", "Cross-chain", "Base"],
  authors: [{ name: "DustSwap Team" }],
  icons: {
    icon: "/logo.svg",
  },
  other: {
    "base:app_id": "6992d2eae0d5d2cf831b5db6",
  },
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
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

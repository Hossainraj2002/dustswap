import type { Metadata, Viewport } from "next";
import { Inter, Nunito } from "next/font/google";
import { AppShell } from "@/components/shell/AppShell";
import { Providers } from "./providers";
import "./globals.css";

// Apple devices render San Francisco from the system stack; Inter and Nunito
// stand in for SF Pro and SF Pro Rounded everywhere else.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const nunito = Nunito({ subsets: ["latin"], variable: "--font-nunito", display: "swap", weight: ["600", "700", "800"] });

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://memefun.dustswap.wtf";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: { default: "memefun: launch and trade meme coins on Base", template: "%s | memefun" },
  description:
    "Launch a meme coin on Base in one transaction. Fixed supply, no admin keys, liquidity locked forever, and every trade pays its creator or its community.",
  applicationName: "memefun",
  appleWebApp: { capable: true, title: "memefun", statusBarStyle: "black-translucent" },
  openGraph: {
    type: "website",
    siteName: "memefun",
    title: "memefun: launch and trade meme coins on Base",
    description: "Fixed supply, no admin keys, liquidity locked forever. Every trade pays the creator or the community.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "memefun on Base" }],
  },
  twitter: { card: "summary_large_image", title: "memefun", description: "Launch and trade meme coins on Base.", images: ["/og.png"] },
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/icon-192.png", sizes: "192x192" }], apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

// Applies the saved or system theme before first paint, so there is no flash.
const themeStartupScript = `
(function () {
  try {
    var preference = window.localStorage.getItem("memefun-theme");
    if (preference !== "light" && preference !== "dark" && preference !== "system") preference = "system";
    var dark = preference === "dark" || (preference === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.themePreference = preference;
    root.style.colorScheme = dark ? "dark" : "light";
  } catch (error) {
    document.documentElement.style.colorScheme = "light";
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${nunito.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeStartupScript }} />
      </head>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}

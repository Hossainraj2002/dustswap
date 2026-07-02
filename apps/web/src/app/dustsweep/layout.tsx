import type { Metadata } from "next";

// Route-scoped metadata for /dustsweep only. This overrides the social share
// image (Open Graph + Twitter) so links to the Dust Sweep tool unfurl with
// sweepog.png, while every other route keeps the global og.png from the root
// layout. Title/description are intentionally left identical to the site
// defaults so only the preview image changes.
//
// Next.js merges metadata shallowly, so the whole `openGraph`/`twitter` objects
// must be re-declared here (not just the image) to avoid dropping their other
// fields. Fields not set here (icons, manifest, fc:frame embed, base:app_id,
// verification) are inherited from the root layout unchanged.
const siteUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.dustswap.wtf";
const siteTitle = "DustSwap | Swap, quests, and progress on Base";
const siteDescription =
  "DustSwap combines swapping, quests, streaks, referrals, and leaderboard progress into one Base-first app.";
const sweepUrl = `${siteUrl}/dustsweep`;

export const metadata: Metadata = {
  openGraph: {
    title: siteTitle,
    description: siteDescription,
    url: sweepUrl,
    siteName: "Dustswap",
    images: [
      {
        url: "/sweepog.png",
        alt: "DustSweep - Sweep your dust into one token on Base",
        width: 1983,
        height: 793,
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: siteTitle,
    description: siteDescription,
    images: ["/sweepog.png"],
  },
};

export default function DustSweepLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <>{children}</>;
}

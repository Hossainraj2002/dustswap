import type { Metadata } from "next";
import { ReferralPageClient } from "./ReferralPageClient";
import { normalizeReferralCode } from "@/lib/referrals";

type ReferralPageProps = {
  params: Promise<{
    code: string;
  }>;
};

const siteUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.dustswap.wtf";
const referralImage = `${siteUrl}/og.png`;

export async function generateMetadata({
  params,
}: ReferralPageProps): Promise<Metadata> {
  const { code } = await params;
  const normalizedCode = normalizeReferralCode(decodeURIComponent(code));
  const referralUrl = `${siteUrl}/ref/${encodeURIComponent(normalizedCode)}`;
  const title = "Join Dustswap | Referral Invite";
  const description = `Use referral code ${normalizedCode} to join Dustswap, swap and bridge on Base, and earn community rewards.`;

  return {
    title,
    description,
    alternates: {
      canonical: referralUrl,
    },
    openGraph: {
      title,
      description,
      url: referralUrl,
      siteName: "Dustswap",
      images: [
        {
          url: referralImage,
          alt: "Dustswap referral invite",
          width: 1200,
          height: 628,
        },
      ],
      locale: "en_US",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [referralImage],
    },
  };
}

export default function ReferralPage({ params }: ReferralPageProps) {
  return <ReferralPageClient params={params} />;
}

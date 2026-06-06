import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RootProfileRedirect } from "./RootProfileRedirect";

type HomePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const siteUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.dustswap.wtf";
const referralTitle = "Join Dustswap on Base";
const referralDescription =
  "Start with a Dustswap referral invite, earn Particle Points, and explore swaps, quests, streaks, and leaderboard progress on Base.";
const referralImage = `${siteUrl}/refog.png`;
const referralSplashImage = `${siteUrl}/logo.png`;

function getSearchParamValue(
  searchParams: Record<string, string | string[] | undefined> | undefined,
  key: string
) {
  const value = searchParams?.[key];
  if (Array.isArray(value)) {
    return value.find(Boolean) || null;
  }

  return value || null;
}

function buildProfileRedirectUrl(
  searchParams?: Record<string, string | string[] | undefined>
) {
  const nextSearchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry) {
          nextSearchParams.append(key, entry);
        }
      }
      continue;
    }

    if (value) {
      nextSearchParams.set(key, value);
    }
  }

  const query = nextSearchParams.toString();
  return query ? `/profile?${query}` : "/profile";
}

export async function generateMetadata({
  searchParams,
}: HomePageProps): Promise<Metadata> {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const referralCode = getSearchParamValue(resolvedSearchParams, "ref");
  if (!referralCode) {
    return {};
  }

  const referralUrl = `${siteUrl}/?ref=${encodeURIComponent(referralCode)}`;
  const referralEmbed = JSON.stringify({
    version: "1",
    imageUrl: referralImage,
    button: {
      title: "Open Dustswap",
      action: {
        type: "launch_frame",
        name: "Dustswap Referral",
        url: referralUrl,
        splashImageUrl: referralSplashImage,
        splashBackgroundColor: "#030305",
      },
    },
  });

  return {
    title: referralTitle,
    description: referralDescription,
    alternates: {
      canonical: referralUrl,
    },
    openGraph: {
      title: referralTitle,
      description: referralDescription,
      url: referralUrl,
      siteName: "Dustswap",
      images: [
        {
          url: "/refog.png",
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
      title: referralTitle,
      description: referralDescription,
      images: ["/refog.png"],
    },
    other: {
      "fc:miniapp": referralEmbed,
      "fc:frame": referralEmbed,
    },
  };
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const target = buildProfileRedirectUrl(resolvedSearchParams);
  if (!getSearchParamValue(resolvedSearchParams, "ref")) {
    redirect(target);
  }

  return <RootProfileRedirect target={target} />;
}

import type { Metadata } from "next";
import { CoinScreen } from "@/components/token/CoinScreen";
import { API_URL, liveConfigured } from "@/lib/live/config";

type Params = { params: Promise<{ address: string }> };

/**
 * Live: the coin's name for the title and the API's share card as the link preview, so a coin
 * link posted anywhere shows the coin. Preview data lives in the browser, so there CoinScreen
 * refines the title once it loads.
 */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  const live = liveConfigured() && process.env.NEXT_PUBLIC_MEMEFUN_PREVIEW !== "1";
  if (!live || !/^0x[0-9a-fA-F]{40}$/.test(address)) return { title: "Coin" };

  let title = "Coin";
  let description: string | undefined;
  try {
    const response = await fetch(`${API_URL}/v1/coins/${address}`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(2_500) });
    if (response.ok) {
      const { coin } = (await response.json()) as { coin: { name: string; symbol: string; description?: string } };
      title = `${coin.name} ($${coin.symbol})`;
      description = coin.description?.trim() || `Trade ${coin.name} on memefun.`;
    }
  } catch {
    // The page still renders; the link preview just falls back to the generic title.
  }
  const image = `${API_URL}/og/coin/${address.toLowerCase()}`;
  return {
    title,
    description,
    openGraph: { title, description, images: [{ url: image, width: 1200, height: 630, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function CoinPage({ params }: Params) {
  const { address } = await params;
  return <CoinScreen address={address} />;
}

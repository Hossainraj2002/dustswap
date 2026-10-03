import type { Metadata } from "next";
import { CoinScreen } from "@/components/token/CoinScreen";

// Preview data lives in the browser, so CoinScreen refines this to the coin name
// once it loads. Phase 3 replaces it with generateMetadata from the indexer.
export const metadata: Metadata = { title: "Coin" };

export default async function CoinPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <CoinScreen address={address} />;
}

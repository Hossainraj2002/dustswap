import type { Metadata } from "next";
import { ClaimPanel } from "@/components/claim/ClaimPanel";

export const metadata: Metadata = {
  title: "Claim USDC | DustSwap",
  description: "Check eligibility and claim your DustSwap USDC airdrop on Base.",
};

export default function ClaimPage() {
  return <ClaimPanel />;
}

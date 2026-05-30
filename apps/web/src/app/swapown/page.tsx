"use client";

import dynamic from "next/dynamic";

const SwapOwnPageClient = dynamic(() => import("@/components/swapown/SwapOwnPageClient"), {
  ssr: false,
});

export default function SwapOwnPage() {
  return <SwapOwnPageClient />;
}

"use client";

import dynamic from "next/dynamic";

const SwapPageClient = dynamic(() => import("@/components/swap/SwapPageClient"), {
  ssr: false,
});

export default function SwapPage() {
  return <SwapPageClient />;
}

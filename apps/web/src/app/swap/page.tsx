"use client";

import { UniswapXSwap } from "@/components/UniswapXSwap";

export default function SwapPage() {
  return (
    <div className="min-h-screen font-dm-sans bg-[#050505] text-white flex flex-col items-center pt-20 px-4">
      <UniswapXSwap />
    </div>
  );
}
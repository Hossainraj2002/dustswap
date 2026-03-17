"use client";

import { SwapBridgeWidget } from "@/components/SwapBridgeWidget";

export default function Home() {
  return (
    <main className="min-h-screen bg-transparent py-8 px-4 flex flex-col">
      <div className="container mx-auto flex-1 flex flex-col">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold mb-2 text-white">Swap & Bridge</h1>
          <p className="text-gray-400">
            Cross-chain swaps powered by LI.FI • Zero gas fees
          </p>
        </div>
        <div className="flex-1 flex items-start justify-center">
          <SwapBridgeWidget />
        </div>
      </div>
      <footer className="mt-auto py-4 text-center text-sm text-gray-500">
        Powered by LI.FI Protocol • Base Builder Program
      </footer>
    </main>
  );
}

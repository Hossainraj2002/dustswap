"use client";

import { SwapBridgeWidget } from "@/components/SwapBridgeWidget";

export default function SwapPage() {
  return (
    <main className="min-h-screen bg-transparent px-4 py-8 flex flex-col">
      <div className="container mx-auto flex-1 flex flex-col">
        <div className="text-center mb-8">
          <h1
            className="text-3xl font-bold mb-2 text-white"
            style={{ fontFamily: "Syne, sans-serif" }}
          >
            Swap & Bridge
          </h1>
          <p
            className="text-gray-400"
            style={{ fontFamily: "DM Sans, sans-serif" }}
          >
            Cross-chain swaps and bridges powered by LI.FI
          </p>
        </div>
        <div className="flex-1 flex items-start justify-center">
          <SwapBridgeWidget />
        </div>
      </div>
      <footer className="mt-auto py-4 text-center text-sm text-gray-500">
        Powered by LI.FI Protocol and Base Builder Program
      </footer>
    </main>
  );
}

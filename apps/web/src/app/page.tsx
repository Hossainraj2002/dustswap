"use client";

import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-transparent py-16 px-4 flex flex-col items-center justify-center text-center">
      <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-1000">
        <div className="space-y-4">
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight text-slate-900" style={{ fontFamily: 'Syne, sans-serif' }}>
            The Future of <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-purple-500 to-pink-500">
              Cross-Chain Swaps
            </span>
          </h1>
          <p className="text-xl md:text-2xl text-slate-500 max-w-2xl mx-auto font-medium" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            Swap and bridge tokens across 20+ chains with zero gas fees. 
            Built for DustSwap on Base with fast, simple cross-chain routing.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 justify-center pt-8">
          <Link
            href="/swap"
            className="px-8 py-4 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-2xl transition-all hover:scale-105 shadow-lg shadow-blue-500/25 text-lg"
          >
            Start Swapping
          </Link>
          <Link
            href="/dustsweep"
            className="px-8 py-4 bg-white hover:bg-slate-50 text-slate-900 font-bold rounded-2xl transition-all border border-slate-200 text-lg shadow-sm"
          >
            Sweep Dust
          </Link>
        </div>

        <div className="pt-16 grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            { title: "Universal Liquidity", desc: "Access liquidity across Ethereum, Base, Solana, and more." },
            { title: "Best Rates", desc: "Optimized routing ensures you get the most tokens for your swap." },
            { title: "Zero Gas Fees", desc: "Sponsored transactions on Base network for a seamless experience." }
          ].map((feature, i) => (
            <div key={i} className="p-6 rounded-3xl bg-white border border-slate-200 shadow-sm backdrop-blur-sm">
              <h3 className="text-lg font-bold mb-2 text-blue-600">{feature.title}</h3>
              <p className="text-slate-500 text-sm">{feature.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

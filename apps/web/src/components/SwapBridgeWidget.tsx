"use client";

import dynamic from "next/dynamic";
import { widgetConfig, LIFI_INTEGRATOR } from "@/config/widget";

const LiFiWidget = dynamic(
  () => import("@lifi/widget").then((mod) => mod.LiFiWidget),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-[600px] flex items-center justify-center bg-gray-900/50 rounded-2xl animate-pulse">
        <p className="text-gray-400">Loading Swap Widget...</p>
      </div>
    ),
  }
);

export function SwapBridgeWidget() {
  return (
    <div className="w-full max-w-2xl mx-auto">
      <LiFiWidget integrator={LIFI_INTEGRATOR} config={widgetConfig} />
    </div>
  );
}

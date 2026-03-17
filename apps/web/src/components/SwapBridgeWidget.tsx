"use client";

import { LiFiWidget } from "@lifi/widget";
import { widgetConfig, LIFI_INTEGRATOR } from "@/config/widget";

export function SwapBridgeWidget() {
  return (
    <div className="w-full max-w-2xl mx-auto">
      <LiFiWidget integrator={LIFI_INTEGRATOR} config={widgetConfig} />
    </div>
  );
}

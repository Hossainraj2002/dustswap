"use client";

import dynamic from "next/dynamic";
import { WidgetSkeleton } from "@lifi/widget";
import { LifiRouteDebugPanel } from "@/components/LifiRouteDebugPanel";
import { widgetConfig, LIFI_INTEGRATOR } from "@/config/widget";

const LiFiWidget = dynamic(
  () => import("@lifi/widget").then((mod) => mod.LiFiWidget),
  {
    ssr: false,
    loading: () => <WidgetSkeleton config={widgetConfig} />,
  }
);

export function SwapBridgeWidget() {
  return (
    <div className="w-full max-w-2xl mx-auto">
      <LiFiWidget integrator={LIFI_INTEGRATOR} config={widgetConfig} />
      <LifiRouteDebugPanel />
    </div>
  );
}

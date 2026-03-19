"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { WidgetSkeleton } from "@lifi/widget";
import { useConnect } from "wagmi";
import { LifiRouteDebugPanel } from "@/components/LifiRouteDebugPanel";
import { createWidgetConfig, LIFI_INTEGRATOR } from "@/config/widget";

const LiFiWidget = dynamic(
  () => import("@lifi/widget").then((mod) => mod.LiFiWidget),
  {
    ssr: false,
    loading: () => <WidgetSkeleton />,
  }
);

export function SwapBridgeWidget() {
  const { connect, connectors } = useConnect();

  const widgetConfig = useMemo(
    () =>
      createWidgetConfig({
        onConnect: () => {
          const coinbaseConnector =
            connectors.find((connector) => connector.id === "coinbaseWallet") ??
            connectors[0];

          if (coinbaseConnector) {
            connect({ connector: coinbaseConnector });
          }
        },
      }),
    [connect, connectors]
  );

  return (
    <div className="w-full max-w-2xl mx-auto">
      <LiFiWidget integrator={LIFI_INTEGRATOR} config={widgetConfig} />
      <LifiRouteDebugPanel />
    </div>
  );
}

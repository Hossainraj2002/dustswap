"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  ChainType,
  type FormFieldChanged,
  WidgetEvent,
  WidgetSkeleton,
  widgetEvents,
} from "@lifi/widget";
import { useAccount, useConnect } from "wagmi";
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
  const { address } = useAccount();
  const { connect, connectors } = useConnect();
  const [selectedToChainId, setSelectedToChainId] = useState<number>();
  const [chainTypesById, setChainTypesById] = useState<Record<number, string>>(
    {}
  );

  useEffect(() => {
    const handleFormFieldChanged = (payload: FormFieldChanged) => {
      if (payload?.fieldName !== "toChain") {
        return;
      }

      setSelectedToChainId(
        typeof payload.newValue === "number" ? payload.newValue : undefined
      );
    };

    widgetEvents.on(WidgetEvent.FormFieldChanged, handleFormFieldChanged);

    return () => {
      widgetEvents.off(WidgetEvent.FormFieldChanged, handleFormFieldChanged);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    const loadChains = async () => {
      try {
        const response = await fetch("https://li.quest/v1/chains", {
          signal: controller.signal,
        });

        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as {
          chains?: Array<{ id: number; chainType: string }>;
        };

        if (!data.chains?.length) {
          return;
        }

        setChainTypesById(
          Object.fromEntries(
            data.chains.map((chain) => [chain.id, chain.chainType])
          )
        );
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.warn("Unable to load LI.FI chain metadata", error);
        }
      }
    };

    void loadChains();

    return () => controller.abort();
  }, []);

  const defaultToAddress = useMemo(() => {
    if (!address || !selectedToChainId) {
      return undefined;
    }

    const destinationChainType = chainTypesById[selectedToChainId];

    if (destinationChainType !== ChainType.EVM) {
      return undefined;
    }

    return {
      address,
      chainType: ChainType.EVM,
      name: "Connected wallet",
    };
  }, [address, chainTypesById, selectedToChainId]);

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
        toAddress: defaultToAddress,
      }),
    [connect, connectors, defaultToAddress]
  );

  return (
    <div className="dustswap-lifi-shell w-full max-w-[980px] mx-auto">
      <LiFiWidget integrator={LIFI_INTEGRATOR} config={widgetConfig} />
      <LifiRouteDebugPanel />
    </div>
  );
}

"use client";

import {
  type DefaultFieldValues,
  type FormFieldChanged,
  type Route,
  type RouteExecutionUpdate,
  type RouteSelected,
  WidgetEvent,
  widgetEvents,
} from "@lifi/widget";
import { useEffect, useEffectEvent, useState } from "react";
import { DEFAULT_SOURCE_CHAIN_ID, SUPPORTED_EVM_CHAINS } from "@/config/web3";

type DebugFieldName = keyof DefaultFieldValues;
type DebugFormState = Partial<DefaultFieldValues>;
type DebugLogLevel = "info" | "warn" | "error" | "success";

type DebugLogEntry = {
  id: string;
  level: DebugLogLevel;
  title: string;
  detail?: string;
  timestamp: string;
};

const trackedFields: DebugFieldName[] = [
  "fromChain",
  "fromToken",
  "toChain",
  "toToken",
  "fromAmount",
  "toAmount",
  "toAddress",
];

const chainNameById = Object.fromEntries(
  SUPPORTED_EVM_CHAINS.map((chain) => [chain.id, chain.name])
) as Record<number, string>;

function formatValue(value: unknown) {
  if (value === undefined || value === "") {
    return "Not selected";
  }
  return String(value);
}

function formatChain(chainId?: number) {
  if (!chainId) {
    return "Not selected";
  }

  return chainNameById[chainId]
    ? `${chainNameById[chainId]} (${chainId})`
    : String(chainId);
}

function formatAddress(value?: string) {
  if (!value) {
    return "Not selected";
  }

  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function getRouteSummary(route: Route) {
  return `${route.fromToken.symbol} on ${formatChain(route.fromChainId)} -> ${route.toToken.symbol} on ${formatChain(route.toChainId)}`;
}

function getExecutionDetail(update: RouteExecutionUpdate) {
  const process = update.process as RouteExecutionUpdate["process"] & {
    message?: string;
    error?: { message?: string } | string;
    txHash?: string;
  };

  const message =
    process.error && typeof process.error === "object"
      ? process.error.message
      : typeof process.error === "string"
        ? process.error
        : process.message;

  const txHash = process.txHash ? `tx ${process.txHash}` : undefined;
  return [process.status, message, txHash].filter(Boolean).join(" - ");
}

export function LifiRouteDebugPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [availableRoutes, setAvailableRoutes] = useState<Route[] | null>(null);
  const [formState, setFormState] = useState<DebugFormState>({
    fromChain: DEFAULT_SOURCE_CHAIN_ID,
    fromAmount: "",
    toAmount: "",
  });
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);

  const appendLog = useEffectEvent(
    (level: DebugLogLevel, title: string, detail?: string) => {
      setLogs((current) =>
        [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            level,
            title,
            detail,
            timestamp: new Date().toLocaleTimeString(),
          },
          ...current,
        ].slice(0, 12)
      );
    }
  );

  useEffect(() => {
    const handleFormFieldChanged = (payload: FormFieldChanged) => {
      if (!payload) {
        return;
      }

      if (!trackedFields.includes(payload.fieldName as DebugFieldName)) {
        return;
      }

      setFormState((current) => ({
        ...current,
        [payload.fieldName]: payload.newValue,
      }));

      if (
        payload.fieldName === "fromAmount" ||
        payload.fieldName === "toAmount"
      ) {
        appendLog(
          "info",
          `${payload.fieldName} updated`,
          formatValue(payload.newValue)
        );
        return;
      }

      appendLog(
        "info",
        `${payload.fieldName} selected`,
        formatValue(payload.newValue)
      );
    };

    const handleAvailableRoutes = (routes: Route[]) => {
      setAvailableRoutes(routes);

      if (!routes.length) {
        setIsOpen(true);
        appendLog(
          "warn",
          "No routes available",
          "The current chain, token, or amount combination returned zero routes."
        );
        return;
      }

      appendLog(
        "success",
        `${routes.length} route${routes.length === 1 ? "" : "s"} available`,
        getRouteSummary(routes[0])
      );
    };

    const handleRouteSelected = ({ route }: RouteSelected) => {
      appendLog("success", "Route selected", getRouteSummary(route));
    };

    const handleRouteExecutionStarted = (route: Route) => {
      appendLog("info", "Execution started", getRouteSummary(route));
    };

    const handleRouteExecutionUpdated = (update: RouteExecutionUpdate) => {
      appendLog("info", "Execution updated", getExecutionDetail(update));
    };

    const handleRouteExecutionFailed = (update: RouteExecutionUpdate) => {
      setIsOpen(true);
      appendLog("error", "Execution failed", getExecutionDetail(update));
    };

    const handleRouteExecutionCompleted = (route: Route) => {
      appendLog("success", "Execution completed", getRouteSummary(route));
    };

    const handleTokensReversed = () => {
      appendLog("info", "Tokens reversed");
    };

    widgetEvents.on(WidgetEvent.FormFieldChanged, handleFormFieldChanged);
    widgetEvents.on(WidgetEvent.AvailableRoutes, handleAvailableRoutes);
    widgetEvents.on(WidgetEvent.RouteSelected, handleRouteSelected);
    widgetEvents.on(WidgetEvent.RouteExecutionStarted, handleRouteExecutionStarted);
    widgetEvents.on(WidgetEvent.RouteExecutionUpdated, handleRouteExecutionUpdated);
    widgetEvents.on(WidgetEvent.RouteExecutionFailed, handleRouteExecutionFailed);
    widgetEvents.on(WidgetEvent.RouteExecutionCompleted, handleRouteExecutionCompleted);
    widgetEvents.on(WidgetEvent.TokensReversed, handleTokensReversed);

    return () => {
      widgetEvents.off(WidgetEvent.FormFieldChanged, handleFormFieldChanged);
      widgetEvents.off(WidgetEvent.AvailableRoutes, handleAvailableRoutes);
      widgetEvents.off(WidgetEvent.RouteSelected, handleRouteSelected);
      widgetEvents.off(WidgetEvent.RouteExecutionStarted, handleRouteExecutionStarted);
      widgetEvents.off(WidgetEvent.RouteExecutionUpdated, handleRouteExecutionUpdated);
      widgetEvents.off(WidgetEvent.RouteExecutionFailed, handleRouteExecutionFailed);
      widgetEvents.off(WidgetEvent.RouteExecutionCompleted, handleRouteExecutionCompleted);
      widgetEvents.off(WidgetEvent.TokensReversed, handleTokensReversed);
    };
  }, [appendLog]);

  const snapshot = {
    formState,
    availableRouteCount: availableRoutes?.length ?? null,
    topRoute: availableRoutes?.[0]
      ? {
          fromChainId: availableRoutes[0].fromChainId,
          toChainId: availableRoutes[0].toChainId,
          fromToken: availableRoutes[0].fromToken.symbol,
          toToken: availableRoutes[0].toToken.symbol,
          fromAmountUSD: availableRoutes[0].fromAmountUSD,
          toAmountUSD: availableRoutes[0].toAmountUSD,
        }
      : null,
    recentEvents: logs,
  };

  const copySnapshot = useEffectEvent(async () => {
    await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  });

  const noRoutes =
    availableRoutes?.length === 0 &&
    Boolean(
      formState.fromChain &&
        formState.toChain &&
        formState.fromToken &&
        formState.toToken
    );

  return (
    <section className="mt-4 w-full rounded-2xl border border-white/10 bg-white/5">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-white">LI.FI Route Debug</p>
          <p className="text-xs text-gray-400">
            Live widget state, route count, and recent LI.FI events.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-1 text-xs font-medium ${
              noRoutes
                ? "bg-amber-500/15 text-amber-300"
                : "bg-emerald-500/15 text-emerald-300"
            }`}
          >
            {noRoutes
              ? "No routes"
              : `${availableRoutes?.length ?? 0} route${availableRoutes?.length === 1 ? "" : "s"}`}
          </span>
          <button
            type="button"
            onClick={() => setIsOpen((current) => !current)}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-gray-200 transition hover:border-white/20 hover:bg-white/5"
          >
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {isOpen ? (
        <div className="space-y-4 border-t border-white/10 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-gray-300">
              Use this snapshot whenever the widget says "No routes available."
            </p>
            <button
              type="button"
              onClick={() => void copySnapshot()}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-gray-200 transition hover:border-white/20 hover:bg-white/5"
            >
              {copied ? "Copied" : "Copy snapshot"}
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl bg-black/20 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                Current selection
              </p>
              <div className="space-y-2 text-sm text-gray-200">
                <div>From chain: {formatChain(formState.fromChain)}</div>
                <div>From token: {formatAddress(formState.fromToken)}</div>
                <div>From amount: {formatValue(formState.fromAmount)}</div>
                <div>To chain: {formatChain(formState.toChain)}</div>
                <div>To token: {formatAddress(formState.toToken)}</div>
                <div>To amount: {formatValue(formState.toAmount)}</div>
                <div>Recipient: {formatAddress(formState.toAddress)}</div>
              </div>
            </div>

            <div className="rounded-xl bg-black/20 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                Route status
              </p>
              <div className="space-y-2 text-sm text-gray-200">
                <div>Available routes: {availableRoutes?.length ?? 0}</div>
                <div>
                  Best route:{" "}
                  {availableRoutes?.[0]
                    ? getRouteSummary(availableRoutes[0])
                    : "None"}
                </div>
                <div>
                  Best route USD:{" "}
                  {availableRoutes?.[0]
                    ? `${availableRoutes[0].fromAmountUSD ?? "?"} -> ${availableRoutes[0].toAmountUSD ?? "?"}`
                    : "N/A"}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-black/20 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Recent events
            </p>
            <div className="space-y-2">
              {logs.length ? (
                logs.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-white">
                        {entry.title}
                      </p>
                      <span
                        className={`text-xs ${
                          entry.level === "error"
                            ? "text-rose-300"
                            : entry.level === "warn"
                              ? "text-amber-300"
                              : entry.level === "success"
                                ? "text-emerald-300"
                                : "text-sky-300"
                        }`}
                      >
                        {entry.timestamp}
                      </span>
                    </div>
                    {entry.detail ? (
                      <p className="mt-1 text-xs text-gray-400">
                        {entry.detail}
                      </p>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="text-sm text-gray-400">
                  Waiting for LI.FI widget events.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

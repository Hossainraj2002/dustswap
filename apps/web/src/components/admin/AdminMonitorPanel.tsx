"use client";

import { useCallback, useMemo, useState, useEffect } from "react";
import {
  type AdminMonitorData,
  type MonitorSeriesPoint,
  type MonitorSummary,
  type MonitorWindowKey,
  fetchAdminMonitor,
} from "@/lib/monitor";

type MetricKey =
  | "users"
  | "transactions"
  | "swappingUsers"
  | "volume"
  | "checkIns"
  | "spins";

type MetricRow = {
  key: MetricKey;
  label: string;
  value: number;
  previous: number;
  displayValue: string;
  chartKey: keyof MonitorSeriesPoint;
  detail: string;
};

const STORAGE_KEY = "monitor-admin-token";
const FALLBACK_STORAGE_KEYS = ["quest-admin-token", "partner-admin-token"];

const WINDOW_OPTIONS: Array<{ key: MonitorWindowKey; label: string; compact: string }> = [
  { key: "utc-day", label: "UTC 00-00", compact: "24h" },
  { key: "3d", label: "Last 3 days", compact: "3d" },
  { key: "7d", label: "Last 7 days", compact: "7d" },
  { key: "30d", label: "Last 30 days", compact: "30d" },
  { key: "90d", label: "Last 90 days", compact: "90d" },
];

function getDisplayError(error: unknown) {
  const message = (error as Error)?.message || "Request failed";
  if (message === "Failed to fetch") {
    return "Could not reach the monitor API. Check NEXT_PUBLIC_API_URL and the API service.";
  }
  return message;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatUtcDateTime(value?: string | null) {
  if (!value) return "No timestamp";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid timestamp";

  return `${date.toLocaleString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })} UTC`;
}

function formatUtcRange(data: AdminMonitorData | null) {
  if (!data) return "UTC day boundaries";
  return `${formatUtcDateTime(data.window.startAt)} to ${formatUtcDateTime(data.window.endAt)}`;
}

function shortHash(value?: string | null) {
  if (!value) return "No hash";
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function shortAddress(value?: string | null) {
  if (!value) return "Unknown";
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function getPercentChange(current: number, previous: number) {
  if (previous === 0) {
    return current === 0 ? 0 : null;
  }
  return ((current - previous) / previous) * 100;
}

function getMetricRows(current: MonitorSummary, previous: MonitorSummary): MetricRow[] {
  return [
    {
      key: "users",
      label: "Tracked users",
      value: current.trackedUsers,
      previous: previous.trackedUsers,
      displayValue: formatNumber(current.trackedUsers),
      chartKey: "trackedUsers",
      detail: `${formatNumber(current.newUsers)} new active, ${formatNumber(
        current.returningUsers
      )} returning, ${formatNumber(current.registeredUsers)} registered`,
    },
    {
      key: "transactions",
      label: "Total transactions",
      value: current.totalTransactions,
      previous: previous.totalTransactions,
      displayValue: formatNumber(current.totalTransactions),
      chartKey: "transactions",
      detail: `${formatNumber(current.swapTransactions)} swaps, ${formatNumber(
        current.sweepTransactions
      )} sweeps, ${formatNumber(current.checkinTransactions)} check-in payments, ${formatNumber(
        current.spinTransactions
      )} spins`,
    },
    {
      key: "swappingUsers",
      label: "Swapping users",
      value: current.swappingUsers,
      previous: previous.swappingUsers,
      displayValue: formatNumber(current.swappingUsers),
      chartKey: "swappingUsers",
      detail: `${formatNumber(current.swapTransactions + current.sweepTransactions)} swap or sweep transactions`,
    },
    {
      key: "volume",
      label: "Total volume",
      value: current.totalVolumeUsd,
      previous: previous.totalVolumeUsd,
      displayValue: formatUsd(current.totalVolumeUsd),
      chartKey: "volumeUsd",
      detail: `${formatUsd(current.swapVolumeUsd)} swap, ${formatUsd(
        current.sweepVolumeUsd
      )} DustSweep, ${formatUsd(current.checkinPaymentUsd)} check-in payment`,
    },
    {
      key: "checkIns",
      label: "Total check-ins",
      value: current.checkIns,
      previous: previous.checkIns,
      displayValue: formatNumber(current.checkIns),
      chartKey: "checkIns",
      detail: `${formatNumber(current.checkInUsers)} check-in users`,
    },
    {
      key: "spins",
      label: "Total spins",
      value: current.spins,
      previous: previous.spins,
      displayValue: formatNumber(current.spins),
      chartKey: "spins",
      detail: `${formatNumber(current.spinUsers)} spin users`,
    },
  ];
}

function MetricDelta({ current, previous }: { current: number; previous: number }) {
  const delta = current - previous;
  const percent = getPercentChange(current, previous);
  const isPositive = delta >= 0;
  const label =
    percent === null
      ? delta > 0
        ? `+${formatCompactNumber(delta)}`
        : "0"
      : `${isPositive ? "+" : ""}${percent.toFixed(1)}%`;

  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-semibold ${
        isPositive
          ? "bg-emerald-50 text-emerald-700"
          : "bg-rose-50 text-rose-700"
      }`}
    >
      {label}
    </span>
  );
}

function SparklineChart({
  series,
  chartKey,
  valueLabel,
}: {
  series: MonitorSeriesPoint[];
  chartKey: keyof MonitorSeriesPoint;
  valueLabel: string;
}) {
  const width = 680;
  const height = 260;
  const padX = 18;
  const padY = 24;
  const values = series.map((point) => Number(point[chartKey] || 0));
  const safeValues = values.length ? values : [0];
  const min = Math.min(0, ...safeValues);
  const max = Math.max(1, ...safeValues);
  const span = max - min || 1;
  const points = safeValues.map((value, index) => {
    const x =
      safeValues.length === 1
        ? width / 2
        : padX + (index / (safeValues.length - 1)) * (width - padX * 2);
    const y = height - padY - ((value - min) / span) * (height - padY * 2);
    return { x, y, value };
  });
  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  const areaPath =
    points.length > 0
      ? `${linePath} L ${points[points.length - 1].x} ${height - padY} L ${points[0].x} ${
          height - padY
        } Z`
      : "";
  const lastPoint = points[points.length - 1];

  return (
    <div className="h-[280px] w-full">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${valueLabel} trend`} className="h-full w-full">
        <defs>
          <linearGradient id="monitor-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#2563eb" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1={padX}
            x2={width - padX}
            y1={padY + ratio * (height - padY * 2)}
            y2={padY + ratio * (height - padY * 2)}
            stroke="#e2e8f0"
            strokeWidth="1"
          />
        ))}
        <path d={areaPath} fill="url(#monitor-area)" />
        <path d={linePath} fill="none" stroke="#2563eb" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        {lastPoint ? (
          <circle cx={lastPoint.x} cy={lastPoint.y} r="6" fill="#2563eb" stroke="#ffffff" strokeWidth="4" />
        ) : null}
      </svg>
    </div>
  );
}

function MetricCards({
  rows,
  selectedMetric,
  onSelect,
}: {
  rows: MetricRow[];
  selectedMetric: MetricKey;
  onSelect: (metric: MetricKey) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          onClick={() => onSelect(row.key)}
          className={`rounded-lg border bg-white p-4 text-left shadow-sm transition hover:border-blue-200 hover:bg-blue-50/40 ${
            selectedMetric === row.key ? "border-blue-300 ring-2 ring-blue-100" : "border-slate-200"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-500">{row.label}</p>
              <p className="mt-2 break-words text-2xl font-semibold text-slate-950">{row.displayValue}</p>
            </div>
            <MetricDelta current={row.value} previous={row.previous} />
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">{row.detail}</p>
        </button>
      ))}
    </div>
  );
}

function MetricTable({
  rows,
  selectedMetric,
  onSelect,
}: {
  rows: MetricRow[];
  selectedMetric: MetricKey;
  onSelect: (metric: MetricKey) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Metric</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Current</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Previous</th>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Breakdown</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr
              key={row.key}
              tabIndex={0}
              onClick={() => onSelect(row.key)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(row.key);
                }
              }}
              className={`cursor-pointer transition ${
                selectedMetric === row.key ? "bg-blue-50/70" : "hover:bg-slate-50"
              }`}
            >
              <td className="px-4 py-3 font-semibold text-slate-950">{row.label}</td>
              <td className="px-4 py-3 text-right">
                <span className="inline-flex rounded-md bg-slate-950 px-2.5 py-1 font-semibold text-white">
                  {row.displayValue}
                </span>
              </td>
              <td className="px-4 py-3 text-right text-slate-500">
                {row.key === "volume" ? formatUsd(row.previous) : formatNumber(row.previous)}
              </td>
              <td className="max-w-[360px] px-4 py-3 text-slate-500">{row.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourceBreakdown({ data }: { data: AdminMonitorData }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Source</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Transactions</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Users</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Volume</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.details.sourceBreakdown.map((row) => (
            <tr key={row.source}>
              <td className="px-4 py-3 font-medium text-slate-950">{row.source}</td>
              <td className="px-4 py-3 text-right text-slate-600">{formatNumber(row.transactions)}</td>
              <td className="px-4 py-3 text-right text-slate-600">{formatNumber(row.users)}</td>
              <td className="px-4 py-3 text-right text-slate-600">{formatUsd(row.volumeUsd)}</td>
            </tr>
          ))}
          {data.details.sourceBreakdown.length === 0 ? (
            <tr>
              <td className="px-4 py-6 text-slate-500" colSpan={4}>No source data in this window.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function UserActivityTable({ data }: { data: AdminMonitorData }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Wallet</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Events</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Swaps</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Check-ins</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Spins</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Volume</th>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Last activity</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.details.userActivity.map((row) => (
            <tr key={`${row.userId}-${row.address}`}>
              <td className="px-4 py-3 font-medium text-slate-950">{shortAddress(row.address)}</td>
              <td className="px-4 py-3 text-right text-slate-600">{formatNumber(row.totalEvents)}</td>
              <td className="px-4 py-3 text-right text-slate-600">
                {formatNumber(row.swapTransactions + row.sweepTransactions)}
              </td>
              <td className="px-4 py-3 text-right text-slate-600">{formatNumber(row.checkIns)}</td>
              <td className="px-4 py-3 text-right text-slate-600">{formatNumber(row.spins)}</td>
              <td className="px-4 py-3 text-right text-slate-600">{formatUsd(row.volumeUsd)}</td>
              <td className="px-4 py-3 text-slate-500">{formatUtcDateTime(row.lastActivityAt)}</td>
            </tr>
          ))}
          {data.details.userActivity.length === 0 ? (
            <tr>
              <td className="px-4 py-6 text-slate-500" colSpan={7}>No user activity in this window.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function TransactionsTable({ data }: { data: AdminMonitorData }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Type</th>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Wallet</th>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Tx</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Volume</th>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.details.transactions.map((row, index) => (
            <tr key={`${row.kind}-${row.txHash}-${index}`}>
              <td className="px-4 py-3 font-medium text-slate-950">{row.kind}</td>
              <td className="px-4 py-3 text-slate-600">{shortAddress(row.address)}</td>
              <td className="px-4 py-3 text-slate-600">{shortHash(row.txHash)}</td>
              <td className="px-4 py-3 text-right text-slate-600">{formatUsd(row.amountUsd)}</td>
              <td className="px-4 py-3 text-slate-500">{formatUtcDateTime(row.occurredAt)}</td>
            </tr>
          ))}
          {data.details.transactions.length === 0 ? (
            <tr>
              <td className="px-4 py-6 text-slate-500" colSpan={5}>No transactions in this window.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function CheckInsTable({ data }: { data: AdminMonitorData }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Wallet</th>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Date</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Points</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Streak</th>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Payment</th>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.details.checkIns.map((row, index) => (
            <tr key={`${row.address}-${row.checkInDate}-${index}`}>
              <td className="px-4 py-3 font-medium text-slate-950">{shortAddress(row.address)}</td>
              <td className="px-4 py-3 text-slate-600">{row.checkInDate || "Unknown"}</td>
              <td className="px-4 py-3 text-right text-slate-600">{formatNumber(row.pointsEarned)}</td>
              <td className="px-4 py-3 text-right text-slate-600">{formatNumber(row.streakDay)}</td>
              <td className="px-4 py-3 text-slate-600">
                {row.paymentTxHash ? `${formatUsd(row.paymentAmountUsd)} ${shortHash(row.paymentTxHash)}` : "None"}
              </td>
              <td className="px-4 py-3 text-slate-500">{formatUtcDateTime(row.occurredAt)}</td>
            </tr>
          ))}
          {data.details.checkIns.length === 0 ? (
            <tr>
              <td className="px-4 py-6 text-slate-500" colSpan={6}>No check-ins in this window.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function SpinsTable({ data }: { data: AdminMonitorData }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Wallet</th>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Reward</th>
            <th className="px-4 py-3 text-right font-semibold text-slate-600">Points</th>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Tx</th>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Status</th>
            <th className="px-4 py-3 text-left font-semibold text-slate-600">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.details.spins.map((row, index) => (
            <tr key={`${row.txHash}-${index}`}>
              <td className="px-4 py-3 font-medium text-slate-950">{shortAddress(row.address)}</td>
              <td className="px-4 py-3 text-slate-600">{row.rewardLabel || row.rewardType || "Reward"}</td>
              <td className="px-4 py-3 text-right text-slate-600">{formatNumber(row.rewardPoints)}</td>
              <td className="px-4 py-3 text-slate-600">{shortHash(row.txHash)}</td>
              <td className="px-4 py-3 text-slate-600">{row.status || "recorded"}</td>
              <td className="px-4 py-3 text-slate-500">{formatUtcDateTime(row.occurredAt)}</td>
            </tr>
          ))}
          {data.details.spins.length === 0 ? (
            <tr>
              <td className="px-4 py-6 text-slate-500" colSpan={6}>No spins in this window.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function DetailPanel({
  selectedMetric,
  data,
}: {
  selectedMetric: MetricKey;
  data: AdminMonitorData;
}) {
  if (selectedMetric === "users" || selectedMetric === "swappingUsers") {
    return (
      <div className="space-y-4">
        <UserActivityTable data={data} />
      </div>
    );
  }

  if (selectedMetric === "transactions" || selectedMetric === "volume") {
    return (
      <div className="space-y-4">
        <SourceBreakdown data={data} />
        <TransactionsTable data={data} />
      </div>
    );
  }

  if (selectedMetric === "checkIns") {
    return <CheckInsTable data={data} />;
  }

  return <SpinsTable data={data} />;
}

export function AdminMonitorPanel() {
  const [adminToken, setAdminToken] = useState("");
  const [selectedWindow, setSelectedWindow] = useState<MonitorWindowKey>("utc-day");
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>("users");
  const [data, setData] = useState<AdminMonitorData | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMonitor = useCallback(
    async (tokenOverride?: string, windowOverride?: MonitorWindowKey) => {
      const tokenToUse = (tokenOverride ?? adminToken).trim();
      const windowToUse = windowOverride ?? selectedWindow;

      if (!tokenToUse) {
        setError("Admin token is required.");
        setIsUnlocked(false);
        setData(null);
        return;
      }

      setIsLoading(true);
      setError(null);
      setStatus(null);

      try {
        const response = await fetchAdminMonitor(tokenToUse, windowToUse);
        if (!response.success || !response.data) {
          throw new Error(response.error || "Failed to load monitor data");
        }

        setData(response.data);
        setIsUnlocked(true);
        setStatus("Monitor data loaded.");
        window.sessionStorage.setItem(STORAGE_KEY, tokenToUse);
      } catch (loadError) {
        setIsUnlocked(false);
        setData(null);
        setError(getDisplayError(loadError));
      } finally {
        setIsLoading(false);
      }
    },
    [adminToken, selectedWindow]
  );

  useEffect(() => {
    const saved =
      window.sessionStorage.getItem(STORAGE_KEY) ||
      FALLBACK_STORAGE_KEYS.map((key) => window.sessionStorage.getItem(key)).find(Boolean) ||
      "";

    if (!saved) {
      return;
    }

    setAdminToken(saved);
    setIsLoading(true);
    setError(null);

    fetchAdminMonitor(saved, "utc-day")
      .then((response) => {
        if (!response.success || !response.data) {
          throw new Error(response.error || "Failed to load monitor data");
        }
        setData(response.data);
        setIsUnlocked(true);
        setStatus("Monitor data loaded.");
        window.sessionStorage.setItem(STORAGE_KEY, saved);
      })
      .catch((loadError) => {
        setIsUnlocked(false);
        setData(null);
        setError(getDisplayError(loadError));
      })
      .finally(() => setIsLoading(false));
  }, []);

  const metricRows = useMemo(
    () => (data ? getMetricRows(data.current, data.previous) : []),
    [data]
  );
  const activeMetric = metricRows.find((row) => row.key === selectedMetric) ?? metricRows[0];

  function handleWindowChange(nextWindow: MonitorWindowKey) {
    setSelectedWindow(nextWindow);
    if (adminToken && isUnlocked) {
      void loadMonitor(adminToken, nextWindow);
    }
  }

  function handleTokenChange(value: string) {
    setAdminToken(value);
    setIsUnlocked(false);
    setData(null);
    setStatus(null);
    setError(null);
    if (!value.trim()) {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  }

  return (
    <div className="theme-page min-h-screen px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <section className="rounded-lg border border-slate-200 bg-white px-5 py-5 shadow-sm sm:px-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-semibold text-blue-600">Admin monitor</p>
              <h1 className="mt-2 text-3xl font-semibold text-slate-950 sm:text-4xl">
                DustSwap activity panel
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">
                {formatUtcRange(data)}
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:items-end">
              <select
                value={selectedWindow}
                onChange={(event) => handleWindowChange(event.target.value as MonitorWindowKey)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 sm:hidden"
              >
                {WINDOW_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>

              <div className="hidden rounded-lg border border-slate-200 bg-slate-50 p-1 sm:flex">
                {WINDOW_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => handleWindowChange(option.key)}
                    className={`rounded-md px-3 py-2 text-sm font-semibold transition ${
                      selectedWindow === option.key
                        ? "bg-slate-950 text-white shadow-sm"
                        : "text-slate-600 hover:bg-white hover:text-slate-950"
                    }`}
                  >
                    {option.compact}
                  </button>
                ))}
              </div>

              {data ? (
                <p className="text-xs text-slate-500">
                  Updated {formatUtcDateTime(data.generatedAt)}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <label className="flex-1">
              <span className="text-sm font-semibold text-slate-900">Admin token</span>
              <input
                type="password"
                value={adminToken}
                onChange={(event) => handleTokenChange(event.target.value)}
                placeholder="Paste MONITOR_ADMIN_TOKEN, QUEST_ADMIN_TOKEN, or PARTNER_ADMIN_TOKEN"
                className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-950 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              />
            </label>

            <button
              type="button"
              onClick={() => void loadMonitor()}
              disabled={!adminToken || isLoading}
              className="rounded-lg bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? "Loading..." : isUnlocked ? "Refresh" : "Load monitor"}
            </button>
          </div>

          {status ? (
            <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {status}
            </p>
          ) : null}
          {error ? (
            <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </p>
          ) : null}
        </section>

        {data && activeMetric ? (
          <>
            <section className="grid gap-5 xl:grid-cols-[1fr_360px]">
              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-500">{activeMetric.label}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <p className="text-3xl font-semibold text-slate-950 sm:text-4xl">
                        {activeMetric.displayValue}
                      </p>
                      <MetricDelta current={activeMetric.value} previous={activeMetric.previous} />
                    </div>
                  </div>
                  <p className="max-w-sm text-sm leading-6 text-slate-500">{activeMetric.detail}</p>
                </div>
                <SparklineChart
                  series={data.series}
                  chartKey={activeMetric.chartKey}
                  valueLabel={activeMetric.label}
                />
              </div>

              <MetricCards
                rows={metricRows}
                selectedMetric={selectedMetric}
                onSelect={setSelectedMetric}
              />
            </section>

            <section className="grid gap-5 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
              <MetricTable
                rows={metricRows}
                selectedMetric={selectedMetric}
                onSelect={setSelectedMetric}
              />

              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-500">Inspection</p>
                    <h2 className="text-xl font-semibold text-slate-950">{activeMetric.label}</h2>
                  </div>
                  <span className="rounded-md bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                    {WINDOW_OPTIONS.find((option) => option.key === selectedWindow)?.label}
                  </span>
                </div>
                <DetailPanel selectedMetric={selectedMetric} data={data} />
              </div>
            </section>
          </>
        ) : (
          <section className="rounded-lg border border-dashed border-slate-300 bg-white px-5 py-12 text-center shadow-sm">
            <p className="text-lg font-semibold text-slate-950">Locked monitor</p>
            <p className="mt-2 text-sm text-slate-500">Load with a valid admin token to view live data.</p>
          </section>
        )}
      </div>
    </div>
  );
}

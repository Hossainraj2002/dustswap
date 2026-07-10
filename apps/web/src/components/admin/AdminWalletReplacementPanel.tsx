"use client";

import { useEffect, useMemo, useState } from "react";
import { getAddress, isAddress } from "viem";
import {
  fetchAdminWalletReplacements,
  previewAdminWalletReplacement,
  replaceAdminWallet,
} from "@/lib/quests";
import type {
  AdminWalletReplacementHistoryEntry,
  AdminWalletReplacementLog,
  AdminWalletReplacementPreview,
  AdminWalletReplacementResult,
} from "@/types/quests";

function normalizeWalletInput(value: string) {
  return isAddress(value.trim()) ? getAddress(value.trim()).toLowerCase() : value.trim();
}

function shortAddress(address?: string | null) {
  if (!address) {
    return "None";
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatError(error: unknown) {
  const message = (error as Error)?.message || "Request failed";
  return message === "Failed to fetch"
    ? "Could not reach the quest API. Check NEXT_PUBLIC_API_URL and try again."
    : message;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function getRelationLabel(relation: AdminWalletReplacementPreview["relation"]) {
  if (relation === "different_user") {
    return "New wallet belongs to another user";
  }
  if (relation === "same_account") {
    return "New wallet is already linked to this account";
  }
  return "New wallet is unused";
}

function logSymbol(level: AdminWalletReplacementLog["level"]) {
  if (level === "plus") return "+";
  if (level === "minus") return "-";
  if (level === "backup") return "backup";
  if (level === "warning") return "!";
  return "i";
}

function LogList({ logs }: { logs: AdminWalletReplacementLog[] }) {
  const [expanded, setExpanded] = useState(false);
  const visibleLogs = expanded ? logs : logs.slice(0, 6);

  if (logs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-4 py-4 text-sm text-gray-500">
        Logs will appear after a replacement runs.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white">
      <div className="max-h-64 divide-y divide-gray-100 overflow-y-auto">
        {visibleLogs.map((log, index) => (
          <div
            key={`${log.level}:${log.message}:${index}`}
            className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 text-sm"
          >
            <span
              className={`rounded-lg px-2 py-1 text-center text-xs font-semibold ${
                log.level === "plus"
                  ? "bg-emerald-50 text-emerald-700"
                  : log.level === "minus"
                    ? "bg-rose-50 text-rose-700"
                    : log.level === "backup"
                      ? "bg-sky-50 text-sky-700"
                      : log.level === "warning"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-gray-100 text-gray-600"
              }`}
            >
              {logSymbol(log.level)}
            </span>
            <span className="min-w-0 text-gray-700">{log.message}</span>
            {typeof log.count === "number" ? (
              <span className="font-mono text-xs text-gray-500">{log.count}</span>
            ) : null}
          </div>
        ))}
      </div>
      {logs.length > 6 ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="w-full border-t border-gray-100 px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50"
        >
          {expanded ? "Show fewer logs" : `Show all ${logs.length} logs`}
        </button>
      ) : null}
    </div>
  );
}

function CountsPreview({
  title,
  totalRows,
  counts,
}: {
  title: string;
  totalRows: number;
  counts: Record<string, number>;
}) {
  const rows = Object.entries(counts || {})
    .map(([key, value]) => [key, Number(value || 0)] as const)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-gray-900">{title}</p>
        <span className="rounded-lg bg-white px-2 py-1 text-xs font-semibold text-gray-700">
          {totalRows.toLocaleString()} rows
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {rows.length === 0 ? (
          <span className="text-xs text-gray-500">No existing rows detected.</span>
        ) : (
          rows.map(([key, value]) => (
            <span
              key={key}
              className="rounded-lg border border-white bg-white px-2.5 py-1.5 text-xs text-gray-700"
            >
              {key.replace(/_/g, " ")}:{" "}
              <span className="font-semibold text-gray-900">{value.toLocaleString()}</span>
            </span>
          ))
        )}
      </div>
    </div>
  );
}

export function AdminWalletReplacementPanel({ adminToken }: { adminToken: string }) {
  const [oldWallet, setOldWallet] = useState("");
  const [newWallet, setNewWallet] = useState("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<AdminWalletReplacementPreview | null>(null);
  const [result, setResult] = useState<AdminWalletReplacementResult | null>(null);
  const [history, setHistory] = useState<AdminWalletReplacementHistoryEntry[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isReplacing, setIsReplacing] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const normalizedOldWallet = useMemo(() => normalizeWalletInput(oldWallet), [oldWallet]);
  const normalizedNewWallet = useMemo(() => normalizeWalletInput(newWallet), [newWallet]);
  const oldWalletValid = isAddress(oldWallet.trim());
  const newWalletValid = isAddress(newWallet.trim());
  const canPreview = Boolean(adminToken && oldWalletValid && newWalletValid);
  const needsConfirmation = Boolean(preview?.requiresConfirmation);
  const canReplace =
    Boolean(preview && adminToken && !isReplacing) &&
    (!needsConfirmation || confirmed);

  async function loadHistory() {
    if (!adminToken) {
      return;
    }

    setIsLoadingHistory(true);
    try {
      const response = await fetchAdminWalletReplacements(adminToken, 12);
      if (!response.success) {
        throw new Error(response.error || "Failed to load wallet replacement history");
      }
      setHistory(response.data || []);
    } catch {
      setHistory([]);
    } finally {
      setIsLoadingHistory(false);
    }
  }

  useEffect(() => {
    setPreview(null);
    setResult(null);
    setConfirmed(false);
    setStatus(null);
    setError(null);
  }, [oldWallet, newWallet]);

  useEffect(() => {
    void loadHistory();
  }, [adminToken]);

  async function handlePreview() {
    if (!canPreview) {
      setError("Enter valid old and new wallet addresses first.");
      return;
    }

    setIsPreviewing(true);
    setError(null);
    setStatus(null);
    setResult(null);
    setConfirmed(false);

    try {
      const response = await previewAdminWalletReplacement(adminToken, {
        oldWallet: normalizedOldWallet,
        newWallet: normalizedNewWallet,
      });

      if (!response.success || !response.data) {
        throw new Error(response.error || "Failed to preview wallet replacement");
      }

      setPreview(response.data);
      setStatus("Preview loaded. Review the destination state before replacing.");
    } catch (previewError) {
      setPreview(null);
      setError(formatError(previewError));
    } finally {
      setIsPreviewing(false);
    }
  }

  async function handleReplace() {
    if (!preview) {
      setError("Preview this replacement first.");
      return;
    }
    if (needsConfirmation && !confirmed) {
      setError("Confirm that the new wallet's existing app data should be overwritten.");
      return;
    }

    setIsReplacing(true);
    setError(null);
    setStatus(null);

    try {
      const response = await replaceAdminWallet(adminToken, {
        oldWallet: preview.oldWallet,
        newWallet: preview.newWallet,
        note: note.trim() || undefined,
      });

      if (!response.success || !response.data) {
        throw new Error(response.error || "Failed to replace wallet");
      }

      setResult(response.data);
      setPreview(null);
      setConfirmed(false);
      setStatus(
        `Wallet replaced. Backup saved as #${response.data.replacementId}.`
      );
      await loadHistory();
    } catch (replaceError) {
      setError(formatError(replaceError));
    } finally {
      setIsReplacing(false);
    }
  }

  return (
    <section className="rounded-[28px] border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-rose-600">
            Wallet Replacement
          </p>
          <h2 className="mt-3 text-2xl font-semibold text-gray-900">
            Move a hacked primary wallet to a new wallet
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-600">
            This keeps the old DustSwap account and rewrites its primary wallet. If the new wallet
            already has DustSwap data, the API saves a backup first and overwrites the live state.
          </p>
        </div>
        {result ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-6 text-emerald-800">
            <p>Last backup</p>
            <p className="font-mono text-[11px]">#{result.replacementId}</p>
          </div>
        ) : null}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label>
              <span className="text-sm font-medium text-gray-900">Old hacked wallet</span>
              <input
                value={oldWallet}
                onChange={(event) => setOldWallet(event.target.value)}
                placeholder="0x..."
                disabled={isReplacing}
                className="mt-2 w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 font-mono text-sm text-gray-900 outline-none shadow-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 placeholder:text-gray-500"
              />
            </label>

            <label>
              <span className="text-sm font-medium text-gray-900">New replacement wallet</span>
              <input
                value={newWallet}
                onChange={(event) => setNewWallet(event.target.value)}
                placeholder="0x..."
                disabled={isReplacing}
                className="mt-2 w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 font-mono text-sm text-gray-900 outline-none shadow-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 placeholder:text-gray-500"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-sm font-medium text-gray-900">Optional admin note</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Example: Discord support ticket / hacked wallet"
              disabled={isReplacing}
              className="mt-2 w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none shadow-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 placeholder:text-gray-500"
            />
          </label>

          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => void handlePreview()}
              disabled={!canPreview || isPreviewing || isReplacing}
              className="rounded-2xl border border-gray-200 bg-white px-5 py-3 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPreviewing ? "Previewing..." : "Preview replacement"}
            </button>
            <button
              type="button"
              onClick={() => void handleReplace()}
              disabled={!canReplace}
              className="rounded-2xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isReplacing ? "Replacing..." : "Replace wallet"}
            </button>
          </div>

          {status ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {status}
            </div>
          ) : null}

          {error ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          ) : null}

          {preview ? (
            <div className="space-y-4 rounded-2xl border border-amber-200 bg-amber-50/50 p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-amber-900">
                    {getRelationLabel(preview.relation)}
                  </p>
                  <p className="mt-1 font-mono text-xs text-amber-800">
                    {shortAddress(preview.oldWallet)} -&gt; {shortAddress(preview.newWallet)}
                  </p>
                </div>
                <span className="rounded-lg bg-white px-2 py-1 text-xs font-semibold text-amber-800">
                  backup before replace
                </span>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <CountsPreview
                  title={`Old account #${preview.oldAccount.userId}`}
                  totalRows={preview.oldAccount.totalRows}
                  counts={preview.oldAccount.counts}
                />
                <CountsPreview
                  title={
                    preview.newWalletState.ownerUserId
                      ? `New wallet owner #${preview.newWalletState.ownerUserId}`
                      : "New wallet state"
                  }
                  totalRows={preview.newWalletState.totalRows}
                  counts={preview.newWalletState.counts}
                />
              </div>

              {preview.warnings.length > 0 ? (
                <div className="space-y-2">
                  {preview.warnings.map((warning) => (
                    <p
                      key={warning}
                      className="rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm text-amber-800"
                    >
                      {warning}
                    </p>
                  ))}
                </div>
              ) : null}

              {needsConfirmation ? (
                <label className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-white px-4 py-3 text-sm text-amber-900">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    I understand the new wallet's live DustSwap data will be backed up and
                    overwritten by the old wallet account.
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}

          {result ? (
            <div className="space-y-3">
              <h3 className="text-base font-semibold text-gray-900">Replacement logs</h3>
              <LogList logs={result.logs} />
            </div>
          ) : null}
        </div>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold text-gray-900">Recent replacements</h3>
              <button
                type="button"
                onClick={() => void loadHistory()}
                disabled={!adminToken || isLoadingHistory}
                className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-900 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoadingHistory ? "Loading" : "Refresh"}
              </button>
            </div>

            <div className="mt-3 space-y-2">
              {history.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-4 py-5 text-sm text-gray-500">
                  No replacements recorded yet.
                </div>
              ) : (
                history.map((entry) => (
                  <details
                    key={entry.replacementId}
                    className="rounded-2xl border border-gray-200 bg-white px-4 py-3"
                  >
                    <summary className="cursor-pointer text-sm font-semibold text-gray-900">
                      #{entry.replacementId} {shortAddress(entry.oldWallet)} -&gt;{" "}
                      {shortAddress(entry.newWallet)}
                    </summary>
                    <p className="mt-2 text-xs text-gray-500">
                      {formatDateTime(entry.createdAt)}
                    </p>
                    {entry.note ? (
                      <p className="mt-2 text-xs leading-5 text-gray-600">{entry.note}</p>
                    ) : null}
                    <div className="mt-3">
                      <LogList logs={entry.logs} />
                    </div>
                  </details>
                ))
              )}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

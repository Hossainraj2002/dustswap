"use client";

import { useEffect, useState } from "react";
import { getAddress, isAddress } from "viem";
import { grantAdminManualPoints } from "@/lib/quests";
import type {
  AdminManualPointsEntryInput,
  AdminManualPointsGrantResult,
} from "@/types/quests";

type GrantMode = "same" | "custom";

type ParsedGrantSummary = {
  entries: AdminManualPointsEntryInput[];
  duplicates: string[];
  invalidRows: string[];
  invalidTokens: string[];
  detectedWalletCount: number;
};

function generateRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `grant-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeAddress(value: string) {
  return getAddress(value.trim()).toLowerCase();
}

function parseSameAmountWallets(rawText: string, sharedAmount: string): ParsedGrantSummary {
  const addressLikeTokens = rawText.match(/\b0x[a-zA-Z0-9]+\b/g) ?? [];
  const duplicates: string[] = [];
  const invalidTokens: string[] = [];
  const entries: AdminManualPointsEntryInput[] = [];
  const seen = new Set<string>();
  const parsedAmount = Number(sharedAmount);
  const hasValidAmount = Number.isInteger(parsedAmount) && parsedAmount > 0;

  for (const token of addressLikeTokens) {
    if (!isAddress(token)) {
      invalidTokens.push(token);
      continue;
    }

    const normalized = normalizeAddress(token);
    if (seen.has(normalized)) {
      duplicates.push(normalized);
      continue;
    }

    seen.add(normalized);
    if (hasValidAmount) {
      entries.push({
        address: normalized,
        points: parsedAmount,
      });
    }
  }

  return {
    entries,
    duplicates,
    invalidRows: [],
    invalidTokens,
    detectedWalletCount: seen.size,
  };
}

function parseCustomAmountWallets(rawText: string): ParsedGrantSummary {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const duplicates: string[] = [];
  const invalidRows: string[] = [];
  const entries: AdminManualPointsEntryInput[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const addressTokens = line.match(/\b0x[a-zA-Z0-9]+\b/g) ?? [];
    const validAddresses = addressTokens.filter((token) => isAddress(token));

    if (validAddresses.length !== 1) {
      invalidRows.push(line);
      continue;
    }

    const normalized = normalizeAddress(validAddresses[0]);
    const amountMatches = line.replace(validAddresses[0], " ").match(/-?\d+(?:\.\d+)?/g) ?? [];
    const parsedAmount = Number(amountMatches[0]);

    if (
      amountMatches.length === 0 ||
      !Number.isInteger(parsedAmount) ||
      parsedAmount <= 0
    ) {
      invalidRows.push(line);
      continue;
    }

    if (seen.has(normalized)) {
      duplicates.push(normalized);
      continue;
    }

    seen.add(normalized);
    entries.push({
      address: normalized,
      points: parsedAmount,
    });
  }

  return {
    entries,
    duplicates,
    invalidRows,
    invalidTokens: [],
    detectedWalletCount: entries.length,
  };
}

function parseGrantInput(
  rawText: string,
  mode: GrantMode,
  sharedAmount: string
): ParsedGrantSummary {
  return mode === "same"
    ? parseSameAmountWallets(rawText, sharedAmount)
    : parseCustomAmountWallets(rawText);
}

function formatError(error: unknown) {
  const message = (error as Error)?.message || "Request failed";
  return message === "Failed to fetch"
    ? "Could not reach the quest API. Check NEXT_PUBLIC_API_URL and try again."
    : message;
}

export function AdminManualPointsPanel({ adminToken }: { adminToken: string }) {
  const [grantMode, setGrantMode] = useState<GrantMode>("same");
  const [walletInput, setWalletInput] = useState("");
  const [sharedAmount, setSharedAmount] = useState("10000");
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState(generateRequestId);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<AdminManualPointsGrantResult | null>(null);

  const parsed = parseGrantInput(walletInput, grantMode, sharedAmount);
  const sharedAmountValue = Number(sharedAmount);
  const sharedAmountError =
    grantMode === "same" &&
    (!Number.isInteger(sharedAmountValue) || sharedAmountValue <= 0)
      ? "Enter a positive whole-number PP amount."
      : null;
  const totalRequestedPoints = parsed.entries.reduce((sum, entry) => sum + entry.points, 0);
  const hasBlockingIssues =
    Boolean(sharedAmountError) ||
    parsed.invalidRows.length > 0 ||
    parsed.invalidTokens.length > 0 ||
    parsed.entries.length === 0;

  useEffect(() => {
    setRequestId(generateRequestId());
    setResult(null);
    setStatus(null);
    setError(null);
  }, [grantMode, walletInput, sharedAmount, note]);

  async function handleSubmit() {
    if (!adminToken) {
      setError("Load quests with a valid admin token first.");
      return;
    }

    if (hasBlockingIssues) {
      setError("Fix the wallet list preview before sending PP.");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setStatus(null);

    try {
      const response = await grantAdminManualPoints(adminToken, {
        entries: parsed.entries,
        note: note.trim() || undefined,
        requestId,
        source: "quest_admin_console",
      });

      if (!response.success || !response.data) {
        throw new Error(response.error || "Failed to grant PP");
      }

      setResult(response.data);
      setStatus(
        response.data.grantedCount === 0 && response.data.reusedCount > 0
          ? "This batch was already processed earlier. No duplicate PP was added."
          : `Granted ${response.data.totalAwardedPoints.toLocaleString()} PP across ${response.data.recipientCount.toLocaleString()} wallet${response.data.recipientCount === 1 ? "" : "s"}.`
      );
    } catch (submitError) {
      setError(formatError(submitError));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="rounded-[28px] border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-600">
            Manual PP Grant
          </p>
          <h2 className="mt-3 text-2xl font-semibold text-gray-900">
            Award exact PP to one or many wallets
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-600">
            These grants add the exact PP amount you enter. They do not use streak boosts and
            they do not trigger referral commission.
          </p>
        </div>
        <div className="rounded-2xl border border-sky-100 bg-sky-50 px-4 py-3 text-xs leading-6 text-sky-800">
          <p>Batch id</p>
          <p className="font-mono text-[11px]">{requestId}</p>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setGrantMode("same")}
              disabled={isSubmitting}
              className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${
                grantMode === "same"
                  ? "border-sky-300 bg-sky-50 text-sky-800"
                  : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
              }`}
            >
              <p className="font-semibold">Same PP for every wallet</p>
              <p className="mt-1 text-xs leading-5">
                Paste one or many wallets and apply one amount to all of them.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setGrantMode("custom")}
              disabled={isSubmitting}
              className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${
                grantMode === "custom"
                  ? "border-sky-300 bg-sky-50 text-sky-800"
                  : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
              }`}
            >
              <p className="font-semibold">Read amount from each line</p>
              <p className="mt-1 text-xs leading-5">
                Use one wallet per line with its PP amount for spreadsheet-style pastes.
              </p>
            </button>
          </div>

          {grantMode === "same" ? (
            <label className="block">
              <span className="text-sm font-medium text-gray-900">PP amount for every wallet</span>
              <input
                type="number"
                min="1"
                step="1"
                value={sharedAmount}
                onChange={(event) => setSharedAmount(event.target.value)}
                disabled={isSubmitting}
                className="mt-2 w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none shadow-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
              />
              {sharedAmountError ? (
                <p className="mt-2 text-xs text-rose-600">{sharedAmountError}</p>
              ) : null}
            </label>
          ) : (
            <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-6 text-gray-600">
              <p className="font-semibold text-gray-900">Accepted per-line formats</p>
              <p>`0xabc... 10000`</p>
              <p>`0xabc...,10000`</p>
              <p>`0xabc... | 10000`</p>
            </div>
          )}

          <label className="block">
            <span className="text-sm font-medium text-gray-900">Wallet input</span>
            <textarea
              value={walletInput}
              onChange={(event) => setWalletInput(event.target.value)}
              disabled={isSubmitting}
              rows={12}
              placeholder={
                grantMode === "same"
                  ? "Paste one or many wallets here. Commas, spaces, and new lines all work."
                  : "Paste one wallet + amount per line."
              }
              className="mt-2 w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none shadow-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 placeholder:text-gray-500"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-900">Optional note</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={isSubmitting}
              placeholder="Example: April trader bonus"
              className="mt-2 w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none shadow-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 placeholder:text-gray-500"
            />
          </label>

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

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting || hasBlockingIssues}
            className="w-full rounded-2xl bg-sky-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting
              ? "Granting PP..."
              : grantMode === "same"
                ? "Apply same PP to all detected wallets"
                : "Grant PP to parsed wallets"}
          </button>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
            <h3 className="text-base font-semibold text-gray-900">Preview</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-white bg-white px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.24em] text-gray-500">
                  Wallets
                </p>
                <p className="mt-2 text-2xl font-semibold text-gray-900">
                  {parsed.detectedWalletCount.toLocaleString()}
                </p>
              </div>
              <div className="rounded-2xl border border-white bg-white px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.24em] text-gray-500">
                  Total PP
                </p>
                <p className="mt-2 text-2xl font-semibold text-gray-900">
                  {totalRequestedPoints.toLocaleString()}
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-2 text-xs leading-6">
              <div className="rounded-2xl border border-white bg-white px-4 py-3 text-gray-700">
                Unique grant rows ready:{" "}
                <span className="font-semibold text-gray-900">
                  {parsed.entries.length.toLocaleString()}
                </span>
              </div>

              {parsed.duplicates.length > 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800">
                  Duplicate wallets skipped: {parsed.duplicates.length}
                </div>
              ) : null}

              {parsed.invalidTokens.length > 0 ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-700">
                  Invalid wallet fragments found: {parsed.invalidTokens.length}
                </div>
              ) : null}

              {parsed.invalidRows.length > 0 ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-700">
                  Lines that need fixing: {parsed.invalidRows.length}
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold text-gray-900">Detected grants</h3>
              <span className="text-xs text-gray-500">
                Showing {Math.min(parsed.entries.length, 12)} of {parsed.entries.length}
              </span>
            </div>

            <div className="mt-3 space-y-2">
              {parsed.entries.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-4 py-5 text-sm text-gray-500">
                  Paste wallets to build the preview.
                </div>
              ) : (
                parsed.entries.slice(0, 12).map((entry) => (
                  <div
                    key={`${entry.address}:${entry.points}`}
                    className="rounded-2xl border border-gray-200 bg-white px-4 py-3"
                  >
                    <p className="font-mono text-xs text-gray-900">{entry.address}</p>
                    <p className="mt-1 text-sm text-gray-600">
                      {entry.points.toLocaleString()} PP
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>

          {result ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <h3 className="text-base font-semibold text-emerald-900">Last response</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-white bg-white px-4 py-3 text-sm text-gray-700">
                  New grants:{" "}
                  <span className="font-semibold text-gray-900">
                    {result.grantedCount.toLocaleString()}
                  </span>
                </div>
                <div className="rounded-2xl border border-white bg-white px-4 py-3 text-sm text-gray-700">
                  Idempotent reuses:{" "}
                  <span className="font-semibold text-gray-900">
                    {result.reusedCount.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { fetchPointHistory, type PointHistoryEntry } from "@/lib/points";

function HistoryIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function LeaderboardHistory() {
  const { address, isConnected } = useAccount();
  const [isOpen, setIsOpen] = useState(false);
  const [history, setHistory] = useState<PointHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && address) {
      setIsLoading(true);
      setError(null);
      fetchPointHistory(address)
        .then((data) => {
          if (data.success) {
            setHistory(data.history);
          } else {
            setError(data.error || "Failed to load history");
          }
        })
        .catch((err) => {
          setError((err as Error).message);
        })
        .finally(() => {
          setIsLoading(false);
        });
    }
  }, [isOpen, address]);

  if (!isConnected) {
    return null;
  }

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white transition hover:bg-white/30"
        title="View PP History"
      >
        <HistoryIcon className="h-4 w-4" />
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="relative w-full max-w-md overflow-hidden rounded-[24px] bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 p-5">
              <h2 className="text-lg font-bold text-slate-900">PP Earning History</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-5">
              {isLoading ? (
                <div className="flex flex-col items-center justify-center py-10">
                  <div className="h-8 w-8 animate-spin rounded-full border-4 border-sky-200 border-t-sky-600"></div>
                  <p className="mt-3 text-sm text-slate-500">Loading history...</p>
                </div>
              ) : error ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-center">
                  <p className="text-sm text-rose-600">{error}</p>
                </div>
              ) : history.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <HistoryIcon className="mb-3 h-10 w-10 text-slate-300" />
                  <p className="text-sm font-medium text-slate-600">No history found</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Complete quests or spin to earn PP.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {history.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 p-3"
                    >
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {entry.label}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {entry.createdAt
                            ? new Date(entry.createdAt).toLocaleString(undefined, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              })
                            : "Recent"}
                        </p>
                      </div>
                      <div className="font-bold text-emerald-600">
                        +{entry.points.toLocaleString()} PP
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

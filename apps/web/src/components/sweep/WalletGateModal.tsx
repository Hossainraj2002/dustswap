"use client";

import { useWalletConnection } from "@/hooks/useWalletConnection";

export function WalletGateModal({
  isOpen,
  walletName,
  reason,
  onClose,
}: {
  isOpen: boolean;
  walletName: string;
  reason: string | null;
  onClose: () => void;
}) {
  const walletConnection = useWalletConnection();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 px-4 backdrop-blur-sm">
      <div className="w-full max-w-[420px] rounded-[8px] bg-white p-5 shadow-[0_30px_80px_rgba(15,23,42,0.24)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-red-600">
              Wallet Not Supported
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              {walletName} cannot run DustSweep
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full text-2xl font-light text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close wallet support modal"
          >
            &times;
          </button>
        </div>

        <p className="mt-4 text-sm leading-6 text-slate-600">
          {reason || "This wallet does not support the batch EIP-712 signing required for DustSweep."}
        </p>

        <div className="mt-4 rounded-[8px] bg-slate-50 p-3">
          <p className="text-sm font-medium text-slate-700">Please connect one of these wallets:</p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            {["Coinbase Wallet", "MetaMask", "Rainbow", "WalletConnect"].map((wallet) => (
              <span
                key={wallet}
                className="rounded-[8px] border border-slate-200 bg-white px-3 py-2 text-center font-medium text-slate-700"
              >
                {wallet}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-5">
          <button
            type="button"
            onClick={() => {
              void walletConnection.openWalletModal("Connect a DustSweep-supported wallet.");
            }}
            className="h-11 w-full rounded-[8px] bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
          >
            Switch Wallet
          </button>
        </div>
      </div>
    </div>
  );
}

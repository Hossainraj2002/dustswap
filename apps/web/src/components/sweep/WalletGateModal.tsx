"use client";

/**
 * DEPRECATED as a hard red full-screen gate. EIP-7702 delegation routing now
 * keeps Permit2 (Route C) reachable for almost every wallet, so this is reduced
 * to a slim, calm inline notice for the genuinely-blocked case only: a wallet
 * that cannot sign typed data at all (no Permit2, no batch — nothing works).
 * It never covers the screen and offers a forward action (switch wallet).
 */
export function WalletGateNotice({
  walletName,
  reason,
  onSwitchWallet,
}: {
  walletName: string;
  reason: string | null;
  onSwitchWallet: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-[8px] border border-blue-200 bg-blue-50 p-4 shadow-sm dark:border-blue-400/20 dark:bg-blue-400/10"
    >
      <p className="text-sm font-semibold text-slate-900 dark:text-white">
        {walletName} can&apos;t sign for DustSweep
      </p>
      <p className="mt-1.5 text-sm leading-6 text-slate-700 dark:text-slate-300">
        {reason ||
          "This wallet can't sign typed data, which DustSweep needs to sweep safely. Connect a different wallet to continue."}
      </p>
      <button
        type="button"
        onClick={onSwitchWallet}
        className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-[8px] bg-blue-600 px-4 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(37,99,235,0.28)] transition-colors hover:bg-blue-700"
      >
        Switch wallet
      </button>
    </div>
  );
}

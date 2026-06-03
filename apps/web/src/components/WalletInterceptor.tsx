"use client";

import { useEffect } from "react";

// DustSweep router contracts — gas estimation failures on these are safe to
// recover from because the sweep transaction always carries an explicit gas limit.
const SWEEP_CONTRACT_ADDRESSES = [
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER,
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V2_ADDRESS,
]
  .filter(Boolean)
  .map((addr) => addr!.toLowerCase());

function isGasEstimationFailure(error: unknown): boolean {
  if (!error || typeof (error as { message?: unknown }).message !== "string") return false;
  const msg = (error as { message: string }).message.toLowerCase();
  return (
    msg.includes("cannot estimate gas") ||
    msg.includes("gas required exceeds allowance") ||
    msg.includes("contract error") ||
    msg.includes("execution reverted") ||
    msg.includes("intrinsic gas too low")
  );
}

export function WalletInterceptor() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const setupInterceptor = () => {
      const ethereum = (window as any).ethereum;
      if (!ethereum || ethereum.__dustswapIntercepted) return;

      const originalRequest = ethereum.request;
      ethereum.request = async (args: any) => {
        try {
          return await originalRequest.call(ethereum, args);
        } catch (error: any) {
          // Retry allowance errors — the approval may not have propagated yet.
          if (
            (args.method === "eth_estimateGas" ||
              args.method === "eth_sendTransaction" ||
              args.method === "eth_call") &&
            error &&
            typeof error.message === "string" &&
            (error.message.toLowerCase().includes("allowance") ||
              error.message.toLowerCase().includes("transfer amount exceeds"))
          ) {
            console.warn(
              "[DustSwap Interceptor] Caught allowance error, retrying...",
              error.message
            );
            // Retry up to 3 times with 3 second delay
            for (let i = 0; i < 3; i++) {
              await new Promise((resolve) => setTimeout(resolve, 3000));
              try {
                return await originalRequest.call(ethereum, args);
              } catch (retryError: any) {
                if (i === 2) throw retryError;
              }
            }
          }

          // TokenPocket calls eth_estimateGas independently for its fee display,
          // even when the sendTransaction already carries an explicit gas limit.
          // Return a generous fallback for sweep contracts so the confirmation UI
          // is not blocked. The actual on-chain gas comes from the explicit limit
          // set by sendSweepTransaction.
          if (
            args.method === "eth_estimateGas" &&
            isGasEstimationFailure(error) &&
            SWEEP_CONTRACT_ADDRESSES.length > 0
          ) {
            const toAddress = (args.params?.[0]?.to ?? "").toLowerCase();
            if (SWEEP_CONTRACT_ADDRESSES.includes(toAddress)) {
              console.warn(
                "[DustSwap Interceptor] Gas estimation failed for sweep contract; providing fallback gas limit.",
                error.message
              );
              // 1,500,000 gas — covers up to ~7 token sweeps with buffer
              return "0x16E360";
            }
          }

          throw error;
        }
      };

      ethereum.__dustswapIntercepted = true;
    };

    setupInterceptor();

    // In case ethereum is injected later by the browser extension
    const timeout = setTimeout(setupInterceptor, 1000);
    return () => clearTimeout(timeout);
  }, []);

  return null;
}

"use client";

import { useEffect } from "react";

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

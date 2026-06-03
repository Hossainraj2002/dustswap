"use client";

import { useEffect } from "react";

const PERMIT2_ADDRESS =
  process.env.NEXT_PUBLIC_PERMIT2_ADDRESS ||
  "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const SWEEP_CONTRACT_ADDRESSES = [
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER,
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V2_ADDRESS,
]
  .filter(Boolean)
  .map((addr) => addr!.toLowerCase());

const APPROVAL_SPENDER_ADDRESSES = [
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER,
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V2_ADDRESS,
  PERMIT2_ADDRESS,
]
  .filter(Boolean)
  .map((addr) => addr!.toLowerCase());

const ERC20_APPROVE_SELECTOR = "095ea7b3";
const APPROVAL_FALLBACK_GAS = 150_000n;
const SWEEP_FALLBACK_GAS_BASE = 500_000n;
const SWEEP_FALLBACK_GAS_PER_ROUTE = 250_000n;

function toHexQuantity(value: bigint) {
  return `0x${value.toString(16)}`;
}

function normalizeHexData(value: unknown) {
  if (typeof value !== "string") return "";
  return value.startsWith("0x")
    ? value.slice(2).toLowerCase()
    : value.toLowerCase();
}

function decodeApproveSpender(data: unknown) {
  const hex = normalizeHexData(data);
  if (!hex.startsWith(ERC20_APPROVE_SELECTOR) || hex.length < 8 + 64) {
    return null;
  }

  return `0x${hex.slice(8 + 24, 8 + 64)}`.toLowerCase();
}

function readFirstDynamicArrayLength(data: unknown) {
  const hex = normalizeHexData(data);
  if (hex.length < 8 + 64) {
    return null;
  }

  try {
    const offset = BigInt(`0x${hex.slice(8, 8 + 64)}`);
    if (offset < 0n || offset > 1_000_000n) {
      return null;
    }

    const lengthStart = 8 + Number(offset) * 2;
    if (lengthStart + 64 > hex.length) {
      return null;
    }

    const length = BigInt(`0x${hex.slice(lengthStart, lengthStart + 64)}`);
    if (length < 0n || length > 100n) {
      return null;
    }

    return Number(length);
  } catch {
    return null;
  }
}

function getSweepFallbackGas(data: unknown) {
  const routeCount = readFirstDynamicArrayLength(data) ?? 5;
  return (
    SWEEP_FALLBACK_GAS_BASE +
    BigInt(Math.max(1, routeCount)) * SWEEP_FALLBACK_GAS_PER_ROUTE
  );
}

function isGasEstimationFailure(error: unknown): boolean {
  if (!error || typeof (error as { message?: unknown }).message !== "string") {
    return false;
  }

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
              error.message,
            );

            for (let i = 0; i < 3; i++) {
              await new Promise((resolve) => setTimeout(resolve, 3000));
              try {
                return await originalRequest.call(ethereum, args);
              } catch (retryError: any) {
                if (i === 2) throw retryError;
              }
            }
          }

          if (
            args.method === "eth_estimateGas" &&
            isGasEstimationFailure(error)
          ) {
            const txRequest = args.params?.[0] || {};
            const toAddress = (txRequest.to ?? "").toLowerCase();
            const approvalSpender = decodeApproveSpender(txRequest.data);

            if (
              approvalSpender &&
              APPROVAL_SPENDER_ADDRESSES.includes(approvalSpender)
            ) {
              console.warn(
                "[DustSwap Interceptor] Gas estimation failed for DustSweep approval; providing fallback gas limit.",
                error.message,
              );
              return toHexQuantity(APPROVAL_FALLBACK_GAS);
            }

            if (SWEEP_CONTRACT_ADDRESSES.includes(toAddress)) {
              console.warn(
                "[DustSwap Interceptor] Gas estimation failed for sweep contract; providing fallback gas limit.",
                error.message,
              );
              return toHexQuantity(getSweepFallbackGas(txRequest.data));
            }
          }

          throw error;
        }
      };

      ethereum.__dustswapIntercepted = true;
    };

    setupInterceptor();

    const timeout = setTimeout(setupInterceptor, 1000);
    return () => clearTimeout(timeout);
  }, []);

  return null;
}

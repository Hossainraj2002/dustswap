import { DATA_SUFFIX } from "@/lib/wallet/builderCode";

/** Copied from apps/web/src/lib/paymaster.ts, trimmed to what memefun uses. */
export const PAYMASTER_URL = process.env.NEXT_PUBLIC_PAYMASTER_URL || "";

/** EIP-5792 capabilities: optional paymaster plus mandatory ERC-8021 attribution. */
export function buildBasePaymasterCapabilities() {
  return {
    ...(PAYMASTER_URL ? { paymasterService: { url: PAYMASTER_URL } } : {}),
    dataSuffix: { value: DATA_SUFFIX },
  };
}

export function isPaymasterEnabled() {
  return PAYMASTER_URL.length > 0;
}

export function isUserRejectedRequest(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: number | string; message?: string; shortMessage?: string };
  const code = String(maybeError.code ?? "");
  const message = `${maybeError.shortMessage || ""} ${maybeError.message || ""}`.toLowerCase();
  return (
    code === "4001" ||
    code === "ACTION_REJECTED" ||
    message.includes("user rejected") ||
    message.includes("user denied") ||
    message.includes("rejected the request")
  );
}

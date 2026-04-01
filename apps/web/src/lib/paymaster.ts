import { DATA_SUFFIX } from "@/lib/builderCode";

export const PAYMASTER_URL = process.env.NEXT_PUBLIC_PAYMASTER_URL || "";
export const STREAK_SAVE_RECIPIENT =
  process.env.NEXT_PUBLIC_STREAK_SAVE_RECIPIENT ||
  "0xe641fB39Fd807B536f37F9268938D67587302E5d";
export const OPENOCEAN_ROUTER_ADDRESSES = new Set([
  "0x6352a56caadc4f1e25cd6c75970fa768a3304e64",
  "0x6dd434082eab5cd134628d4b9a6e4d0813ef8b07",
]);
export const ERC20_APPROVE_SELECTOR = "0x095ea7b3";

export function buildBasePaymasterCapabilities() {
  return {
    ...(PAYMASTER_URL
      ? {
          paymasterService: {
            url: PAYMASTER_URL,
          },
        }
      : {}),
    dataSuffix: {
      value: DATA_SUFFIX,
      optional: true,
    },
  };
}

export function isPaymasterEnabled() {
  return PAYMASTER_URL.length > 0;
}

export function isOpenOceanRouterAddress(value: unknown) {
  return typeof value === "string" && OPENOCEAN_ROUTER_ADDRESSES.has(value.toLowerCase());
}

export function isErc20ApproveCall(value: unknown) {
  return typeof value === "string" && value.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR);
}

export function isUserRejectedRequest(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as {
    code?: number | string;
    message?: string;
    shortMessage?: string;
  };
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

export function toRpcHexValue(value: unknown) {
  if (typeof value === "string" && value.startsWith("0x")) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    try {
      return `0x${BigInt(value).toString(16)}`;
    } catch {
      return "0x0";
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return `0x${BigInt(value).toString(16)}`;
  }

  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`;
  }

  return "0x0";
}

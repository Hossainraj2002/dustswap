import { type Address, type Hex } from "viem";

export type DustSweepDexName =
  | "UNISWAP_V3"
  | "UNISWAP_V4"
  | "AERODROME"
  | "PANCAKESWAP_V3"
  | "BASESWAP"
  | "GENERIC";

export type UnavailableReason =
  | "NO_LIQUIDITY"
  | "NOT_WHITELISTED"
  | "BELOW_THRESHOLD"
  | "BALANCE_CHANGED"
  | "QUOTE_FAILED"
  | "UNKNOWN_PRICE"
  | "SPAM_OR_DENYLISTED";

export type SweepStep = "idle" | "approving" | "signing" | "pending" | "success" | "error";

export type WalletSupportTier = "tier1" | "tier2" | "blocked" | "unknown";

export type Token = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  balance?: string;
  balanceFormatted?: string;
  valueUSD?: number;
};

export type SwappableToken = Token & {
  balance: string;
  balanceFormatted: string;
  valueUSD: number;
  bestDex: Exclude<DustSweepDexName, "UNISWAP_V4"> | "GENERIC";
  liquidityUSD: number;
  status?: "SWAPPABLE" | "NATIVE_WRAP_REQUIRED";
  isNative?: boolean;
  wrapRequired?: boolean;
};

export type UnavailableToken = Token & {
  balance: string;
  balanceFormatted: string;
  valueUSD: number;
  reason: UnavailableReason;
  status?: string;
};

export type SelectedToken = SwappableToken;

export type DustSweepTokensResponse = {
  swappable: SwappableToken[];
  unavailable: UnavailableToken[];
};

export type DustSweepRoute = {
  tokenIn: Address;
  amountIn: string;
  amountOutMin: string;
  estimatedOut: string;
  dex: number;
  dexName: string;
  dexData: Hex;
  priceImpactBps: number;
  poolFee?: number;
};

export type DustSweepQuoteRequest = {
  tokenIns: Address[];
  amounts: string[];
  tokenOut: Address;
  slippageBps: number;
  userAddress: Address;
};

export type DustSweepQuoteResponse = {
  routes: DustSweepRoute[];
  skippedTokens?: {
    token: Address;
    reason: UnavailableReason;
    message?: string;
  }[];
  totalEstimatedOut: string;
  totalEstimatedOutUSD: number;
  feeAmountUSD: number;
  feeBps: number;
  gasEstimateETH: string;
  gasEstimateUSD: number;
  permit2Nonce: string;
  deadline: number;
  executionLane?: string;
  routeMaxCap?: number;
};

export type Permit2TypedData = {
  domain: {
    name: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: {
    TokenPermissions: readonly [
      { readonly name: "token"; readonly type: "address" },
      { readonly name: "amount"; readonly type: "uint256" },
    ];
    PermitBatchTransferFrom: readonly [
      { readonly name: "permitted"; readonly type: "TokenPermissions[]" },
      { readonly name: "spender"; readonly type: "address" },
      { readonly name: "nonce"; readonly type: "uint256" },
      { readonly name: "deadline"; readonly type: "uint256" },
    ];
  };
  message: {
    permitted: { token: Address; amount: string }[];
    spender: Address;
    nonce: string;
    deadline: string;
  };
};

export type DustSweepBuildTxRequest = {
  routes: DustSweepRoute[];
  tokenOut: Address;
  receiver: Address;
  deadline: number;
  permit2Nonce: string;
  userAddress: Address;
};

export type DustSweepBuildTxResponse = {
  permit2: Permit2TypedData;
  contractAddress: Address;
  calldata: Hex;
  callMode?: string;
  executionLane?: string;
  routeMaxCap?: number;
};

export type DustSweepRecordRequest = {
  txHash: Hex;
  userAddress: Address;
  tokensSwapped: number;
  valueUSD: number;
};

export type DustSweepRecordResponse = {
  success: boolean;
  questProgress?: Record<string, unknown>;
};

export type SweepButtonVisualState =
  | { state: "disabled"; label: "Select tokens" }
  | { state: "disabled"; label: "Select output token" }
  | { state: "preview"; label: "Preview Sweep" }
  | { state: "ready"; label: "Sweep Now" }
  | { state: "loading"; label: "Getting best route..." }
  | { state: "approving"; label: "Approve tokens..." }
  | { state: "signing"; label: "Sign in wallet..." }
  | { state: "pending"; label: "Sweeping..." }
  | { state: "success"; label: "Swept! View on Basescan" }
  | { state: "error"; label: "Try again" };

export type WalletWhitelistStatus = {
  isSupported: boolean;
  isChecking: boolean;
  tier: WalletSupportTier;
  connectorId: string | null;
  walletName: string;
  reason: string | null;
  supportsEIP712: boolean;
  isCoinbaseSmartWallet: boolean;
};

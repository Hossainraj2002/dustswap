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
  | "SPAM_OR_DENYLISTED"
  | "NATIVE_WRAP_REQUIRED"
  | "CANT_TRANSFER"
  | "OUTPUT_ASSET";

export type TokenDiscoveryStatus =
  | "DISCOVERED"
  | "PRICED"
  | "LIQUIDITY_PENDING"
  | "SWAPPABLE"
  | "NOT_SWEEPABLE"
  | "HIDDEN"
  | "SPAM"
  | "UNKNOWN_PRICE"
  | "NO_LIQUIDITY"
  | "NATIVE_WRAP_REQUIRED"
  | "EXCLUDED_OUTPUT_ASSET";

export type TokenPriceConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export type DustSweepExecutionLane = "owned_v1" | "owned_v2" | "owned_v3" | "basket_aggregator";
export type DustSweepSignatureMode = "none" | "permit2_witness";

export type SweepStep = "idle" | "approving" | "signing" | "pending" | "success" | "error";

export type WalletSupportTier = "tier1" | "tier2" | "blocked" | "unknown";
export type DustSweepWalletKey =
  | "ambire"
  | "base_account"
  | "bitget"
  | "coinbase"
  | "cryptocom"
  | "imtoken"
  | "injected"
  | "metamask"
  | "okx"
  | "phantom"
  | "rabby"
  | "rainbow"
  | "safe"
  | "tokenpocket"
  | "trust"
  | "uniswap"
  | "walletconnect"
  | "zerion"
  | "unknown";
export type DustSweepExecutionStrategy =
  | "capability_gated_batch"
  | "coinbase_paymaster"
  | "permit2_fallback"
  | "tokenpocket_existing";
export type DustSweepAtomicStatus = "ready" | "supported" | "unsupported" | "unknown";

export type DustSweepWalletProfile = {
  walletKey: DustSweepWalletKey;
  walletName: string;
  executionStrategy: DustSweepExecutionStrategy;
  atomicStatus: DustSweepAtomicStatus;
  batchNotice: string | null;
};

// ── EIP-7702 delegation-aware routing ──
// The three sweep routes derived from the on-chain delegation + the connected
// wallet's batch capability (see docs/eip7702-delegation-aware-workflow.md §4).
export type SweepRouteKind = "batch" | "switch_or_permit2" | "permit2";

// Identity of whatever a delegated EOA points to on Base. `state` mirrors the
// §3 matrix: no delegation, a delegate we can name, or a delegate we cannot.
export type DelegateIdentity =
  | { state: "none" }
  | { state: "known"; wallet: DustSweepWalletKey; label: string }
  | { state: "unknown"; delegate: Address };

export type SweepDelegation = {
  address: Address | null;
  info: DelegateIdentity;
};

// The wallet the UI should suggest switching to for Route B (one-click batch).
export type RecommendedWallet = {
  key: DustSweepWalletKey;
  label: string;
};

export type Token = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  balance?: string;
  balanceFormatted?: string;
  valueUSD?: number;
  status?: TokenDiscoveryStatus;
  sourceType?: "native" | "wallet" | "protocol";
  priceUSD?: number;
  priceSource?: "canonical" | "coingecko" | "dexscreener" | "blockscout" | "none";
  priceConfidence?: TokenPriceConfidence;
  liquidityUSD?: number;
  riskScore?: number;
  riskReasons?: string[];
  isNative?: boolean;
  wrapRequired?: boolean;
};

export type SwappableToken = Token & {
  balance: string;
  balanceFormatted: string;
  valueUSD: number;
  bestDex: DustSweepDexName;
  liquidityUSD: number;
  status?: TokenDiscoveryStatus;
  isNative?: boolean;
  wrapRequired?: boolean;
};

export type UnavailableToken = Token & {
  balance: string;
  balanceFormatted: string;
  valueUSD: number;
  reason: UnavailableReason;
  status?: TokenDiscoveryStatus;
};

export type SelectedToken = SwappableToken;

export type DustSweepTokensResponse = {
  discovery?: {
    erc20BalanceCount?: number;
    alchemyScannedBalanceCount?: number;
    alchemyPageCount?: number;
    truncated?: boolean;
    source?: "alchemy" | "blockscout";
    providerError?: string;
    stale?: boolean;
    staleReason?: string;
    maxErc20Balances?: number | null;
    targetNonZeroBalances?: number | null;
    maxAlchemyPages?: number | null;
    maxBlockscoutPages?: number | null;
    marketHintCount?: number;
    metadataReadCount?: number;
    elapsedMs?: number;
  };
  swappable: SwappableToken[];
  unavailable: UnavailableToken[];
  hidden?: UnavailableToken[];
  suspicious?: UnavailableToken[];
  excludedOutputAssets?: UnavailableToken[];
  refreshedAt?: string;
  chainId?: number;
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
  // True when priceImpactBps was computed from the token's market value vs the quoted output;
  // false means no reliable reference price existed and the number is NOT meaningful.
  priceImpactKnown?: boolean;
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
  // WETH selected with native-ETH output: a 1:1 WETH.withdraw() the user's wallet performs as a
  // separate plain transaction (never part of the router sweep, no protocol fee). Deliberately
  // kept OUT of the router totals below; the UI adds it to the displayed receive amounts.
  wethUnwrap?: { amount: string; valueUSD: number };
  skippedTokens?: {
    token: Address;
    reason: UnavailableReason;
    message?: string;
  }[];
  totalEstimatedOut: string;
  minAmountOut?: string;
  protocolFeeAmount?: string;
  netEstimatedOut?: string;
  totalEstimatedOutUSD: number;
  feeAmountUSD: number;
  netEstimatedOutUSD?: number;
  // Worst known route impact (bps) and whether the API asks for an explicit user
  // confirmation before sweeping at this impact level.
  maxPriceImpactBps?: number;
  requiresImpactConfirmation?: boolean;
  // BASKET-level impact across routes with a reliable reference price: total expected market
  // value minus total quoted output. This is the honest dollar figure to display — never derive
  // dollars from maxPriceImpactBps (worst single token) times the whole basket.
  basketImpactUSD?: number;
  basketImpactBps?: number;
  feeBps: number;
  gasEstimateETH: string;
  gasEstimateUSD: number;
  permit2Nonce: string;
  deadline: number;
  executionLane?: DustSweepExecutionLane;
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
    PermitBatchTransferFrom?: readonly [
      { readonly name: "permitted"; readonly type: "TokenPermissions[]" },
      { readonly name: "spender"; readonly type: "address" },
      { readonly name: "nonce"; readonly type: "uint256" },
      { readonly name: "deadline"; readonly type: "uint256" },
    ];
    DustSweepWitness?: readonly [
      { readonly name: "routeHash"; readonly type: "bytes32" },
      { readonly name: "outputToken"; readonly type: "address" },
      { readonly name: "receiver"; readonly type: "address" },
      { readonly name: "minAmountOut"; readonly type: "uint256" },
      { readonly name: "deadline"; readonly type: "uint256" },
    ];
    PermitBatchWitnessTransferFrom?: readonly [
      { readonly name: "permitted"; readonly type: "TokenPermissions[]" },
      { readonly name: "spender"; readonly type: "address" },
      { readonly name: "nonce"; readonly type: "uint256" },
      { readonly name: "deadline"; readonly type: "uint256" },
      { readonly name: "witness"; readonly type: "DustSweepWitness" },
    ];
  };
  primaryType?: "PermitBatchTransferFrom" | "PermitBatchWitnessTransferFrom";
  message: {
    permitted: { token: Address; amount: string }[];
    spender: Address;
    nonce: string;
    deadline: string;
    witness?: {
      routeHash: Hex;
      outputToken: Address;
      receiver: Address;
      minAmountOut: string;
      deadline: string;
    };
  };
};

export type DustSweepV2Route = {
  tokenIn: Address;
  amountIn: string;
  target: Address;
  spender: Address;
  value: string;
  data: Hex;
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
  requiresSignature?: boolean;
  signatureMode?: DustSweepSignatureMode;
  approvalSpender?: Address;
  approvalRequirements?: {
    token: Address;
    required: string;
    allowance: string;
    spender: Address;
  }[];
  routerAddress?: Address;
  routeMaxCap?: number;
  typedData?: Permit2TypedData;
  permit2?: Permit2TypedData;
  permit?: {
    permitted: { token: Address; amount: string }[];
    nonce: string;
    deadline: string;
  };
  witness?: Permit2TypedData["message"]["witness"];
  witnessHash?: Hex;
  routes?: DustSweepV2Route[];
  // Tokens the backend pre-flight dropped because their transferFrom would revert
  // the atomic pull (transfer tax / max-tx / blacklist / honeypot). The returned
  // `routes` and `calldata` already exclude these.
  skippedTokens?: {
    token: Address;
    reason: UnavailableReason;
    message?: string;
  }[];
  minAmountOut?: string;
  value?: string;
  contractAddress: Address;
  calldata: Hex;
  callMode?: string;
  executionLane?: DustSweepExecutionLane;
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

export type DustSweepCompletionInput = Pick<
  SelectedToken,
  "address" | "symbol" | "name" | "decimals" | "logoURI" | "balanceFormatted" | "valueUSD"
> & {
  estimatedOut: string;
  dexName: string;
};

export type DustSweepCompletionSummary = {
  txHash: Hex;
  tokenOut: Token;
  tokenOutAmount: string;
  tokenOutValueUSD: number;
  inputValueUSD: number;
  feeAmountUSD: number;
  gasEstimateUSD: number;
  routeCount: number;
  walletName: string;
  routeKind: SweepRouteKind;
  completedAt: number;
  inputs: DustSweepCompletionInput[];
};

export type SweepButtonVisualState =
  | { state: "disabled"; label: "Select tokens" }
  | { state: "disabled"; label: "Select output token" }
  | { state: "disabled"; label: "No route available" }
  | { state: "disabled"; label: "Confirm high price impact" }
  | { state: "preview"; label: "Preview Sweep" }
  | { state: "ready"; label: "Sweep" }
  | { state: "loading"; label: "Finding balances..." }
  | { state: "loading"; label: "Getting best route..." }
  | { state: "loading"; label: "Finding route..." }
  | { state: "approving"; label: "Approve tokens..." }
  | { state: "setup"; label: "Approve setup..." }
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

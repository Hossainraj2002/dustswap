import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  type Address,
  type Hex,
} from "viem";

/**
 * DustSweep V3 (DustSwapSweepRouter) client helpers.
 *
 * ADDITIVE: this module sits alongside the working V1/V2 client (dustsweep-router.ts) and
 * does not modify it. There is NO V2/V3 fallback. To go live on V3, deploy the contract from
 * Remix and set the single env value below; existing wallet detection / send-class logic
 * (dustsweep-wallets.ts) is reused unchanged.
 */

export const DUST_SWEEP_ROUTER_V3_ADDRESS = (process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;

export const V3_MAX_BATCH_SIZE = 50;
export const V3_MAX_FEE_BPS = 300;
/** Sentinel feeBpsOverride meaning "use the contract default feeBps". */
export const V3_FEE_OVERRIDE_SENTINEL = 65535;
/** outputToken sentinel meaning "native ETH out (unwrap WETH)". */
export const V3_NATIVE_TOKEN_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

/** How inputs are pulled. Plain EOAs => Permit2Signature; EIP-7702/5792 batch => Allowance. */
export enum DustSweepV3Mode {
  Permit2Signature = 0,
  Allowance = 1,
}

export type DustSweepV3RouteInput = {
  tokenIn: Address;
  amountIn: string | bigint;
  target: Address;
  spender: Address;
  value?: string | bigint;
  data: Hex;
};

export type DustSweepV3ParamsInput = {
  outputToken: Address;
  recipient: Address;
  minAmountOut: string | bigint;
  deadline: number | bigint;
  /**
   * Fee in bps for this sweep. Omit to use the contract default (the FEE_OVERRIDE_SENTINEL).
   * SECURITY (audit L-1): in Allowance mode pass an EXPLICIT value, not the sentinel — otherwise
   * an owner `setFeeBps` could change the fee of an in-flight sweep (bounded to MAX_FEE_BPS=3%).
   * In Permit2Signature mode the fee is bound in the signed witness, so the sentinel is safe there.
   */
  feeBpsOverride?: number;
};

export type DustSweepV3PermitInput = {
  permitted: { token: Address; amount: string | bigint }[];
  nonce: string | bigint;
  deadline: string | bigint;
};

export const dustSweepRouterV3Abi = [
  {
    name: "sweep",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "mode", type: "uint8" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "target", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "outputToken", type: "address" },
          { name: "recipient", type: "address" },
          { name: "minAmountOut", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "feeBpsOverride", type: "uint16" },
        ],
      },
      {
        name: "permit",
        type: "tuple",
        components: [
          {
            name: "permitted",
            type: "tuple[]",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [
      { name: "grossAmountOut", type: "uint256" },
      { name: "feeAmount", type: "uint256" },
      { name: "netAmountOut", type: "uint256" },
    ],
  },
] as const;

const EMPTY_PERMIT: DustSweepV3PermitInput = { permitted: [], nonce: 0n, deadline: 0n };

function toBig(value: string | bigint | number | undefined): bigint {
  if (value === undefined) return 0n;
  return typeof value === "bigint" ? value : BigInt(value);
}

function normalizeRoutes(routes: DustSweepV3RouteInput[]) {
  return routes.map((route) => ({
    tokenIn: route.tokenIn,
    amountIn: toBig(route.amountIn),
    target: route.target,
    spender: route.spender,
    value: toBig(route.value),
    data: route.data,
  }));
}

function normalizeParams(params: DustSweepV3ParamsInput) {
  const feeBpsOverride = params.feeBpsOverride ?? V3_FEE_OVERRIDE_SENTINEL;
  if (feeBpsOverride !== V3_FEE_OVERRIDE_SENTINEL && feeBpsOverride > V3_MAX_FEE_BPS) {
    throw new Error(`feeBpsOverride ${feeBpsOverride} exceeds MAX_FEE_BPS ${V3_MAX_FEE_BPS}`);
  }
  return {
    outputToken: params.outputToken,
    recipient: params.recipient,
    minAmountOut: toBig(params.minAmountOut),
    deadline: toBig(params.deadline),
    feeBpsOverride,
  };
}

/**
 * Encode `DustSwapSweepRouter.sweep(...)` calldata.
 * - Allowance mode (EIP-7702/5792 smart wallets): permit/signature are ignored; pass none.
 * - Permit2Signature mode (plain EOAs): pass the signed permit + signature.
 */
export function encodeDustSweepV3Calldata(args: {
  mode: DustSweepV3Mode;
  routes: DustSweepV3RouteInput[];
  params: DustSweepV3ParamsInput;
  permit?: DustSweepV3PermitInput;
  signature?: Hex;
}): Hex {
  if (!args.routes.length) {
    throw new Error("DustSweep V3 sweep requires at least one route");
  }
  const permit = args.permit ?? EMPTY_PERMIT;
  return encodeFunctionData({
    abi: dustSweepRouterV3Abi,
    functionName: "sweep",
    args: [
      args.mode,
      normalizeRoutes(args.routes),
      normalizeParams(args.params),
      {
        permitted: permit.permitted.map((p) => ({ token: p.token, amount: toBig(p.amount) })),
        nonce: toBig(permit.nonce),
        deadline: toBig(permit.deadline),
      },
      args.signature ?? "0x",
    ],
  });
}

const SWEEP_ROUTE_TYPEHASH = keccak256(
  encodePacked(
    ["string"],
    [
      "SweepRoute(address tokenIn,uint256 amountIn,address target,address spender,uint256 value,bytes32 dataHash)",
    ],
  ),
);

/**
 * Recompute the route hash exactly as `DustSwapSweepRouter.hashRoutes` does, for binding into
 * the Permit2 witness. Order-sensitive.
 */
export function buildDustSweepV3RouteHash(routes: DustSweepV3RouteInput[]): Hex {
  const routeHashes = routes.map((route) =>
    keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "address" },
          { type: "uint256" },
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
          { type: "bytes32" },
        ],
        [
          SWEEP_ROUTE_TYPEHASH,
          route.tokenIn,
          toBig(route.amountIn),
          route.target,
          route.spender,
          toBig(route.value),
          keccak256(route.data),
        ],
      ),
    ),
  );
  return keccak256(encodePacked(["bytes32[]"], [routeHashes]));
}

/**
 * EIP-712 witness type the user signs in Permit2Signature mode. Note the fields differ from V2:
 * `recipient` (not `receiver`) and an extra `feeBps`, so the user signs the exact fee charged.
 * The signed feeBps MUST equal the effective fee the contract computes (override or default).
 */
export const DUST_SWEEP_V3_WITNESS_TYPES = {
  DustSweepWitness: [
    { name: "routeHash", type: "bytes32" },
    { name: "outputToken", type: "address" },
    { name: "recipient", type: "address" },
    { name: "minAmountOut", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "feeBps", type: "uint16" },
  ],
} as const;

export function buildDustSweepV3Witness(args: {
  routes: DustSweepV3RouteInput[];
  outputToken: Address;
  recipient: Address;
  minAmountOut: string | bigint;
  deadline: number | bigint;
  /** The effective fee in bps the contract will charge (resolved override or default). */
  effectiveFeeBps: number;
}) {
  return {
    routeHash: buildDustSweepV3RouteHash(args.routes),
    outputToken: args.outputToken,
    recipient: args.recipient,
    minAmountOut: toBig(args.minAmountOut).toString(),
    deadline: toBig(args.deadline).toString(),
    feeBps: args.effectiveFeeBps,
  };
}

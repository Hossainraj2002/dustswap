import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

// API route discriminator only; the V3 sweep contract receives generic target/spender/calldata.
export const SOLIDLY_DEX_ID = 12;

export const SOLIDLY_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,(address from,address to,bool stable,address factory)[] routes,address to,uint256 deadline) returns (uint256[] amounts)",
]);

const SOLIDLY_DEX_DATA_PARAMETERS = [
  { name: "router", type: "address" },
  {
    name: "routes",
    type: "tuple[]",
    components: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "stable", type: "bool" },
      { name: "factory", type: "address" },
    ],
  },
] as const;

export type SolidlyRoute = {
  from: Address;
  to: Address;
  stable: boolean;
  factory: Address;
};

export function getSolidlyQuotePaths(args: {
  tokenIn: Address;
  tokenOut: Address;
  factory: Address;
  intermediates: Address[];
}): SolidlyRoute[][] {
  const { tokenIn, tokenOut, factory } = args;
  const paths: SolidlyRoute[][] = [false, true].map((stable) => [
    { from: tokenIn, to: tokenOut, stable, factory },
  ]);
  const seen = new Set([tokenIn.toLowerCase(), tokenOut.toLowerCase()]);
  for (const mid of args.intermediates) {
    if (seen.has(mid.toLowerCase())) continue;
    seen.add(mid.toLowerCase());
    for (const stableA of [false, true]) {
      for (const stableB of [false, true]) {
        paths.push([
          { from: tokenIn, to: mid, stable: stableA, factory },
          { from: mid, to: tokenOut, stable: stableB, factory },
        ]);
      }
    }
  }
  return paths;
}

export function encodeSolidlyDexData(router: Address, routes: SolidlyRoute[]): Hex {
  return encodeAbiParameters(SOLIDLY_DEX_DATA_PARAMETERS, [router, routes]);
}

export function buildSolidlySwapCall(args: {
  dexData: Hex;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOutMin: bigint;
  receiver: Address;
  deadline: number;
  sources: Array<{ kind: string; router: Address; factory?: Address }>;
}): { target: Address; spender: Address; value: bigint; data: Hex } {
  const [router, routes] = decodeAbiParameters(SOLIDLY_DEX_DATA_PARAMETERS, args.dexData) as readonly [
    Address,
    readonly SolidlyRoute[],
  ];
  const source = args.sources.find(
    (candidate) => candidate.kind === "solidly" && candidate.router.toLowerCase() === router.toLowerCase(),
  );
  if (!source?.factory || routes.length < 1 || routes.length > 2) {
    throw new Error("Solidly route is not configured on this chain");
  }
  if (
    routes[0].from.toLowerCase() !== args.tokenIn.toLowerCase() ||
    routes[routes.length - 1].to.toLowerCase() !== args.tokenOut.toLowerCase() ||
    routes.some((route, index) =>
      route.factory.toLowerCase() !== source.factory!.toLowerCase() ||
      route.from.toLowerCase() === route.to.toLowerCase() ||
      (index > 0 && route.from.toLowerCase() !== routes[index - 1].to.toLowerCase()),
    )
  ) {
    throw new Error("Malformed Solidly route path or factory");
  }
  return {
    target: router,
    spender: router,
    value: 0n,
    data: encodeFunctionData({
      abi: SOLIDLY_ROUTER_ABI,
      functionName: "swapExactTokensForTokens",
      args: [args.amountIn, args.amountOutMin, routes, args.receiver, BigInt(args.deadline)],
    }),
  };
}

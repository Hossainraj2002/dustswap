import { isAddress, type Address } from "viem";
import { arbitrum, avalanche, base, bsc, mainnet, polygon } from "viem/chains";

export type SwapOwnSourceType = "v2" | "v3";

export type SwapOwnSource = {
  id: string;
  chainId: number;
  chainKey: string;
  name: string;
  type: SwapOwnSourceType;
  router: Address;
  spender?: Address;
  quoter?: Address;
  fee?: number;
  enabled: boolean;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const MIN_ACTIVE_SOURCES_PER_CHAIN = 15;

const CHAIN_KEYS_BY_ID = new Map<number, string>([
  [base.id, "base"],
  [mainnet.id, "ethereum"],
  [bsc.id, "bsc"],
  [polygon.id, "polygon"],
  [arbitrum.id, "arbitrum"],
  [avalanche.id, "avalanche"],
]);

const DEFAULT_SOURCE_DEFINITIONS: Array<Omit<SwapOwnSource, "enabled">> = [
  ...v3SourceSet({
    chainId: base.id,
    chainKey: "base",
    name: "Uniswap V3",
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    fees: [100, 500, 3000, 10000],
  }),
  ...v3SourceSet({
    chainId: base.id,
    chainKey: "base",
    name: "PancakeSwap V3",
    router: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
    quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
    fees: [100, 500, 2500, 10000],
  }),
  v2Source({
    chainId: base.id,
    chainKey: "base",
    name: "BaseSwap",
    router: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86",
  }),

  ...v3SourceSet({
    chainId: mainnet.id,
    chainKey: "ethereum",
    name: "Uniswap V3",
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    fees: [100, 500, 3000, 10000],
  }),
  v2Source({
    chainId: mainnet.id,
    chainKey: "ethereum",
    name: "Uniswap V2",
    router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  }),
  v2Source({
    chainId: mainnet.id,
    chainKey: "ethereum",
    name: "SushiSwap V2",
    router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
  }),

  ...v3SourceSet({
    chainId: bsc.id,
    chainKey: "bsc",
    name: "PancakeSwap V3",
    router: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
    quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
    fees: [100, 500, 2500, 10000],
  }),
  v2Source({
    chainId: bsc.id,
    chainKey: "bsc",
    name: "PancakeSwap V2",
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  }),

  ...v3SourceSet({
    chainId: polygon.id,
    chainKey: "polygon",
    name: "Uniswap V3",
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    fees: [100, 500, 3000, 10000],
  }),
  v2Source({
    chainId: polygon.id,
    chainKey: "polygon",
    name: "QuickSwap V2",
    router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  }),
  v2Source({
    chainId: polygon.id,
    chainKey: "polygon",
    name: "SushiSwap V2",
    router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
  }),

  ...v3SourceSet({
    chainId: arbitrum.id,
    chainKey: "arbitrum",
    name: "Uniswap V3",
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    fees: [100, 500, 3000, 10000],
  }),
  v2Source({
    chainId: arbitrum.id,
    chainKey: "arbitrum",
    name: "SushiSwap V2",
    router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
  }),

  v2Source({
    chainId: avalanche.id,
    chainKey: "avalanche",
    name: "Trader Joe V1",
    router: "0x60aE616a2155Ee3d9A68541Ba4544862310933d4",
  }),
  v2Source({
    chainId: avalanche.id,
    chainKey: "avalanche",
    name: "Pangolin V2",
    router: "0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106",
  }),
];

function v2Source(args: {
  chainId: number;
  chainKey: string;
  name: string;
  router: Address;
}): Omit<SwapOwnSource, "enabled"> {
  return {
    id: `${args.chainKey}-${slug(args.name)}`,
    chainId: args.chainId,
    chainKey: args.chainKey,
    name: args.name,
    type: "v2",
    router: args.router,
    spender: args.router,
  };
}

function v3SourceSet(args: {
  chainId: number;
  chainKey: string;
  name: string;
  router: Address;
  quoter: Address;
  fees: number[];
}) {
  return args.fees.map((fee) => ({
    id: `${args.chainKey}-${slug(args.name)}-${fee}`,
    chainId: args.chainId,
    chainKey: args.chainKey,
    name: `${args.name} ${formatFee(fee)}`,
    type: "v3" as const,
    router: args.router,
    spender: args.router,
    quoter: args.quoter,
    fee,
  }));
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function formatFee(fee: number) {
  return `${fee / 10_000}%`;
}

function splitCsv(value?: string) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSource(raw: Partial<SwapOwnSource>): SwapOwnSource | null {
  const chainId = Number(raw.chainId);
  const type = raw.type === "v2" || raw.type === "v3" ? raw.type : null;
  const router = String(raw.router || "");
  const quoter = String(raw.quoter || "");
  const spender = String(raw.spender || raw.router || "");
  const chainKey = String(raw.chainKey || CHAIN_KEYS_BY_ID.get(chainId) || chainId || "");
  const fee = Number(raw.fee);

  if (!Number.isFinite(chainId) || !type || !isAddress(router) || !isAddress(spender)) {
    return null;
  }

  if (type === "v3" && (!isAddress(quoter) || !Number.isFinite(fee))) {
    return null;
  }

  return {
    id: String(raw.id || `${chainKey}-${type}-${router}-${type === "v3" ? fee : "direct"}`),
    chainId,
    chainKey,
    name: String(raw.name || `${type.toUpperCase()} source`),
    type,
    router: router as Address,
    spender: spender as Address,
    quoter: type === "v3" ? (quoter as Address) : undefined,
    fee: type === "v3" ? fee : undefined,
    enabled: raw.enabled !== false,
  };
}

function getEnvSources() {
  const rawJson = process.env.SWAPOWN_DIRECT_SOURCES_JSON || process.env.DUSTSWAP_DIRECT_SOURCES_JSON;
  if (!rawJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawJson) as Array<Partial<SwapOwnSource>>;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map(normalizeSource).filter((source): source is SwapOwnSource => Boolean(source));
  } catch {
    return [];
  }
}

function getDisabledSourceIds() {
  return new Set(splitCsv(process.env.SWAPOWN_DISABLED_SOURCE_IDS));
}

export function getSwapOwnSources(chainId?: number) {
  const disabled = getDisabledSourceIds();
  const envSources = getEnvSources();
  const baseSources = envSources.length > 0
    ? envSources
    : DEFAULT_SOURCE_DEFINITIONS.map((source) => ({
        ...source,
        enabled:
          isAddress(source.router) &&
          source.router !== ZERO_ADDRESS &&
          (!source.quoter || source.quoter !== ZERO_ADDRESS),
      }));

  return baseSources
    .map((source) => ({
      ...source,
      enabled: source.enabled && !disabled.has(source.id),
    }))
    .filter((source) => (chainId == null ? true : source.chainId === chainId));
}

export function getActiveSwapOwnSources(chainId: number) {
  return getSwapOwnSources(chainId).filter((source) => source.enabled);
}

export function getSwapOwnSourceReadiness(chainId: number) {
  const sources = getSwapOwnSources(chainId);
  const activeSources = sources.filter((source) => source.enabled);
  return {
    chainId,
    chainKey: CHAIN_KEYS_BY_ID.get(chainId) || String(chainId),
    minActiveSources: MIN_ACTIVE_SOURCES_PER_CHAIN,
    activeSourceCount: activeSources.length,
    configuredSourceCount: sources.length,
    productionReady: activeSources.length >= MIN_ACTIVE_SOURCES_PER_CHAIN,
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name,
      type: source.type,
      fee: source.fee,
      router: source.router,
      quoter: source.quoter,
      enabled: source.enabled,
    })),
  };
}

function getRouterMap() {
  const rawJson =
    process.env.DUSTSWAP_AGGREGATOR_ROUTERS_JSON ||
    process.env.NEXT_PUBLIC_DUSTSWAP_AGGREGATOR_ROUTERS_JSON;
  if (!rawJson) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawJson) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getSwapOwnRouterAddress(chainId: number): Address | null {
  const chainKey = CHAIN_KEYS_BY_ID.get(chainId);
  const routerMap = getRouterMap();
  const candidates = [
    process.env[`DUSTSWAP_AGGREGATOR_ROUTER_${chainId}`],
    process.env[`NEXT_PUBLIC_DUSTSWAP_AGGREGATOR_ROUTER_${chainId}`],
    chainKey ? process.env[`DUSTSWAP_AGGREGATOR_ROUTER_${chainKey.toUpperCase()}`] : undefined,
    chainKey ? process.env[`NEXT_PUBLIC_DUSTSWAP_AGGREGATOR_ROUTER_${chainKey.toUpperCase()}`] : undefined,
    routerMap[String(chainId)],
    chainKey ? routerMap[chainKey] : undefined,
  ];

  const found = candidates.find((candidate) =>
    candidate && isAddress(candidate) && candidate.toLowerCase() !== ZERO_ADDRESS
  );
  return found ? (found as Address) : null;
}

export function getSwapOwnFeeBps() {
  const parsed = Number(process.env.DUSTSWAP_AGGREGATOR_FEE_BPS || "25");
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(300, Math.floor(parsed)) : 25;
}

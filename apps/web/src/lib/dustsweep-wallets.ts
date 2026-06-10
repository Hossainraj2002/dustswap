import { base } from "viem/chains";
import {
  getEthereumProviderCandidates,
  hasInjectedMetaMaskWallet,
  isOkxEthereumProvider,
  isTokenPocketEthereumProvider,
  mergeEthereumProviderCandidates,
  type EthereumProviderCandidate,
} from "@/lib/ethereumProviders";
import {
  isDustSweepApprovalBatchingEnabled,
  METAMASK_APPROVAL_BATCHING_DISABLED_NOTICE,
} from "@/lib/dustsweep-feature-flags";
import {
  type DustSweepAtomicStatus,
  type DustSweepWalletKey,
  type DustSweepWalletProfile,
} from "@/types/dustsweep";

export type WalletRpcRequest = (args: {
  method: string;
  params?: unknown[];
}) => Promise<unknown>;

type EthereumFlags = {
  isAmbire?: boolean;
  isBitgetWallet?: boolean;
  isBitKeep?: boolean;
  isCoinbaseWallet?: boolean;
  isCryptoCom?: boolean;
  isCryptoComWallet?: boolean;
  isImToken?: boolean;
  isMetaMask?: boolean;
  isOKExWallet?: boolean;
  isOKXWallet?: boolean;
  isOkxWallet?: boolean;
  isPhantom?: boolean;
  isRabby?: boolean;
  isRainbow?: boolean;
  isSafe?: boolean;
  isTokenPocket?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
  isUniswapWallet?: boolean;
  isZerion?: boolean;
};

export type WalletRpcProvider = EthereumFlags & EthereumProviderCandidate & {
  request?: WalletRpcRequest;
  providers?: WalletRpcProvider[];
  selectedProvider?: WalletRpcProvider;
  info?: { name?: string; rdns?: string };
  name?: string;
};

type WalletChainCapabilities = {
  atomic?: { status?: unknown; supported?: unknown };
  atomicBatch?: { supported?: unknown };
};

type DustSweepWalletProfileBase = Omit<
  DustSweepWalletProfile,
  "atomicStatus" | "batchNotice"
>;

function normalizeWalletSignal(value?: string | null) {
  return value?.trim().toLowerCase().replace(/[\s.-]+/g, "_") || "";
}

function includesWalletSignal(value: string, ...needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

function getRawEthereumProviders(): WalletRpcProvider[] {
  return getEthereumProviderCandidates<WalletRpcProvider>();
}

function getEthereumFlags(): EthereumFlags {
  return mergeEthereumProviderCandidates<WalletRpcProvider>() as EthereumFlags;
}

function buildWalletSignal(args: {
  walletClientType?: string | null;
  connectorId?: string | null;
  connectorName?: string | null;
  walletName?: string | null;
}) {
  return [
    args.walletClientType,
    args.connectorId,
    args.connectorName,
    args.walletName,
  ]
    .map(normalizeWalletSignal)
    .filter(Boolean)
    .join("_");
}

function getInjectedWalletKey(flags: EthereumFlags): DustSweepWalletKey | null {
  if (flags.isRabby) return "rabby";
  if (flags.isTrust || flags.isTrustWallet) return "trust";
  if (isTokenPocketEthereumProvider(flags) || flags.isTokenPocket) {
    return "tokenpocket";
  }
  if (
    isOkxEthereumProvider(flags) ||
    flags.isOKExWallet ||
    flags.isOKXWallet ||
    flags.isOkxWallet
  ) {
    return "okx";
  }
  if (flags.isRainbow) return "rainbow";
  if (flags.isBitgetWallet || flags.isBitKeep) return "bitget";
  if (flags.isZerion) return "zerion";
  if (flags.isAmbire) return "ambire";
  if (flags.isImToken) return "imtoken";
  if (flags.isPhantom) return "phantom";
  if (flags.isUniswapWallet) return "uniswap";
  if (flags.isCryptoCom || flags.isCryptoComWallet) return "cryptocom";
  if (flags.isSafe) return "safe";
  if (flags.isCoinbaseWallet) return "coinbase";
  if (flags.isMetaMask) return "metamask";
  return null;
}

function getSignalWalletKey(signal: string): DustSweepWalletKey | null {
  if (includesWalletSignal(signal, "base_account", "base_app", "base_wallet", "coinbase_smart_wallet")) {
    return "base_account";
  }
  if (includesWalletSignal(signal, "rabby", "rabby_wallet")) return "rabby";
  if (includesWalletSignal(signal, "trust", "trust_wallet")) return "trust";
  if (includesWalletSignal(signal, "tokenpocket", "token_pocket")) return "tokenpocket";
  if (includesWalletSignal(signal, "okx", "okex", "okx_wallet")) return "okx";
  if (includesWalletSignal(signal, "rainbow")) return "rainbow";
  if (includesWalletSignal(signal, "safe", "gnosis")) return "safe";
  if (includesWalletSignal(signal, "bitget", "bitkeep", "bitget_wallet")) return "bitget";
  if (includesWalletSignal(signal, "zerion")) return "zerion";
  if (includesWalletSignal(signal, "ambire")) return "ambire";
  if (includesWalletSignal(signal, "imtoken", "im_token")) return "imtoken";
  if (includesWalletSignal(signal, "phantom")) return "phantom";
  if (includesWalletSignal(signal, "uniswap", "uniswap_wallet")) return "uniswap";
  if (includesWalletSignal(signal, "cryptocom", "crypto_com")) return "cryptocom";
  if (includesWalletSignal(signal, "coinbase", "coinbase_wallet")) {
    return "coinbase";
  }
  if (includesWalletSignal(signal, "walletconnect", "wallet_connect")) return "walletconnect";
  if (includesWalletSignal(signal, "metamask", "meta_mask")) return "metamask";
  if (includesWalletSignal(signal, "injected", "detected_ethereum_wallets")) {
    return "injected";
  }
  return null;
}

function getExecutionStrategy(walletKey: DustSweepWalletKey) {
  if (walletKey === "tokenpocket") {
    return "tokenpocket_existing" as const;
  }

  if (walletKey === "base_account" || walletKey === "coinbase") {
    return "coinbase_paymaster" as const;
  }

  return "capability_gated_batch" as const;
}

export function getDustSweepWalletProfileBase(args: {
  walletClientType?: string | null;
  connectorId?: string | null;
  connectorName?: string | null;
  walletName: string;
  isCoinbaseSmartWallet: boolean;
}): DustSweepWalletProfileBase {
  const combinedSignal = buildWalletSignal(args);
  const connectorSignal = normalizeWalletSignal(args.connectorId);
  const signalKey = getSignalWalletKey(combinedSignal);
  const injectedKey = getInjectedWalletKey(getEthereumFlags());
  const hasMetaMaskRuntime = hasInjectedMetaMaskWallet();
  const shouldPreferInjectedOkx =
    injectedKey === "okx" &&
    (!signalKey ||
      signalKey === "walletconnect" ||
      signalKey === "injected" ||
      (signalKey === "metamask" && !hasMetaMaskRuntime));
  const shouldPreferInjectedTokenPocket =
    injectedKey === "tokenpocket" &&
    (!signalKey ||
      signalKey === "walletconnect" ||
      signalKey === "injected" ||
      (signalKey === "metamask" && !hasMetaMaskRuntime));
  const mayUseInjectedFlags =
    !combinedSignal ||
    signalKey === "injected" ||
    connectorSignal === "injected" ||
    includesWalletSignal(combinedSignal, "detected_ethereum_wallets");

  let walletKey: DustSweepWalletKey = "unknown";
  if (shouldPreferInjectedTokenPocket) {
    walletKey = "tokenpocket";
  } else if (shouldPreferInjectedOkx) {
    walletKey = "okx";
  } else if (signalKey && signalKey !== "injected") {
    walletKey = signalKey;
  } else if (args.isCoinbaseSmartWallet) {
    walletKey = "base_account";
  } else if (mayUseInjectedFlags && injectedKey) {
    walletKey = injectedKey;
  } else if (signalKey === "injected") {
    walletKey = "injected";
  }

  return {
    walletKey,
    walletName: args.walletName || "Unknown wallet",
    executionStrategy: getExecutionStrategy(walletKey),
  };
}

export function getWalletBatchNotice(
  walletName: string,
  walletKey: DustSweepWalletKey,
  atomicStatus: DustSweepAtomicStatus,
) {
  if (
    (atomicStatus === "supported" || atomicStatus === "ready") &&
    !isDustSweepApprovalBatchingEnabled(walletKey)
  ) {
    return METAMASK_APPROVAL_BATCHING_DISABLED_NOTICE;
  }

  if (atomicStatus === "supported") {
    if (walletKey === "base_account" || walletKey === "coinbase") {
      return `${walletName} can batch token approvals; DustSweep sends approvals first, then the sweep for a reliable Base Account review.`;
    }
    if (walletKey === "tokenpocket") {
      return "TokenPocket estimates DustSweep more reliably with explicit-gas approvals. DustSweep sends approvals first, then the sweep after allowances are confirmed.";
    }

    return `${walletName} can batch token approvals and the sweep in one atomic request.`;
  }

  if (atomicStatus === "ready") {
    if (walletKey === "tokenpocket") {
      return "TokenPocket batching is available, but DustSweep uses explicit-gas approvals first to keep TokenPocket gas estimation reliable.";
    }
    return `${walletName} can enable atomic batching through a wallet-managed EIP-7702 upgrade prompt.`;
  }

  if (walletKey === "rabby" && atomicStatus === "unsupported") {
    return "Rabby is connected, but public atomic batching is unavailable. DustSweep will use Permit2 approvals and a standard sweep.";
  }

  if (walletKey === "tokenpocket" && atomicStatus === "unsupported") {
    return null;
  }

  if (atomicStatus === "unsupported") {
    return "Atomic approval+sweep batching is unavailable on this wallet connection. DustSweep will use Permit2 approvals and a standard sweep.";
  }

  return null;
}

function getWindowEthereumProviders(walletKey?: DustSweepWalletKey): WalletRpcProvider[] {
  const uniqueProviders = getRawEthereumProviders();

  if (!walletKey || walletKey === "injected" || walletKey === "unknown") {
    return uniqueProviders;
  }

  return uniqueProviders.filter((provider) => {
    const providerSignal = buildWalletSignal({
      walletClientType: provider.info?.rdns,
      connectorId: provider.name,
      connectorName: provider.info?.name,
      walletName: undefined,
    });
    return (
      getInjectedWalletKey(provider) === walletKey ||
      getSignalWalletKey(providerSignal) === walletKey ||
      (walletKey === "okx" && isOkxEthereumProvider(provider)) ||
      (walletKey === "tokenpocket" && isTokenPocketEthereumProvider(provider))
    );
  });
}

export function getWalletRequestCandidates(
  walletClient: unknown,
  walletKey?: DustSweepWalletKey,
  options?: { preferInjected?: boolean },
): WalletRpcRequest[] {
  const clientCandidates: WalletRpcRequest[] = [];
  const providerCandidates: WalletRpcRequest[] = [];
  const clientRequest = (walletClient as { request?: WalletRpcRequest } | null)?.request;
  if (typeof clientRequest === "function") {
    clientCandidates.push((args) => clientRequest.call(walletClient, args));
  }

  for (const provider of getWindowEthereumProviders(walletKey)) {
    if (typeof provider.request === "function") {
      const request = provider.request;
      providerCandidates.push((args) => request.call(provider, args));
    }
  }

  return options?.preferInjected
    ? [...providerCandidates, ...clientCandidates]
    : [...clientCandidates, ...providerCandidates];
}

export function getWalletRequest(
  walletClient: unknown,
  walletKey?: DustSweepWalletKey,
): WalletRpcRequest | null {
  return getWalletRequestCandidates(walletClient, walletKey)[0] ?? null;
}

export function getAtomicStatus(atomic: unknown): DustSweepAtomicStatus {
  if (!atomic || typeof atomic !== "object") {
    return "unknown";
  }

  const capability = atomic as { status?: unknown; supported?: unknown };
  const status = typeof capability.status === "string" ? capability.status.toLowerCase() : "";
  if (status === "ready" || status === "supported" || status === "unsupported") {
    return status;
  }

  if (typeof capability.supported === "string") {
    const supported = capability.supported.toLowerCase();
    if (supported === "ready" || supported === "supported" || supported === "unsupported") {
      return supported;
    }
  }

  if (capability.supported === true) {
    return "supported";
  }

  if (capability.supported === false) {
    return "unsupported";
  }

  return "unknown";
}

export function getBatchCapabilityStatus(
  chainCapabilities: unknown,
): DustSweepAtomicStatus {
  if (!chainCapabilities || typeof chainCapabilities !== "object") {
    return "unknown";
  }

  const capability = chainCapabilities as WalletChainCapabilities;
  const atomicStatus = getAtomicStatus(capability.atomic);
  if (atomicStatus !== "unknown") {
    return atomicStatus;
  }

  if (capability.atomicBatch?.supported === true) {
    return "ready";
  }

  if (capability.atomicBatch?.supported === false) {
    return "unsupported";
  }

  return "unsupported";
}

export function isBatchCapabilitySupported(chainCapabilities: unknown) {
  const status = getBatchCapabilityStatus(chainCapabilities);
  return status === "ready" || status === "supported";
}

export function getChainCapabilities(capabilities: unknown, chainId = base.id) {
  if (!capabilities || typeof capabilities !== "object") {
    return undefined;
  }

  const byChain = capabilities as Record<string, WalletChainCapabilities | undefined>;
  const chainIdHex = `0x${chainId.toString(16)}`;
  const chainIdDecimal = String(chainId);

  return byChain[chainIdHex] || byChain[chainIdHex.toUpperCase()] || byChain[chainIdDecimal] || byChain["0x0"];
}

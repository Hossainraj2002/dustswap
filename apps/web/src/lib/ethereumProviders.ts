export type EthereumProviderCandidate = {
  isOKExWallet?: boolean;
  isOKXWallet?: boolean;
  isOkxWallet?: boolean;
  info?: { name?: string; rdns?: string };
  name?: string;
  providers?: EthereumProviderCandidate[];
  selectedProvider?: EthereumProviderCandidate;
};

const knownOkxProviders = new WeakSet<object>();

export function getEthereumProviderCandidates<
  TProvider extends EthereumProviderCandidate = EthereumProviderCandidate,
>(): TProvider[] {
  if (typeof window === "undefined") {
    return [];
  }

  const browserWindow = window as Window & {
    ethereum?: TProvider;
    okxwallet?: TProvider;
  };
  const ethereum = browserWindow.ethereum;
  if (browserWindow.okxwallet && typeof browserWindow.okxwallet === "object") {
    knownOkxProviders.add(browserWindow.okxwallet);
  }

  const candidates = [
    browserWindow.okxwallet,
    ethereum?.selectedProvider,
    ...(Array.isArray(ethereum?.providers) ? ethereum.providers : []),
    ethereum,
  ].filter(Boolean) as TProvider[];

  return candidates.filter(
    (provider, index) =>
      candidates.findIndex((candidate) => candidate === provider) === index
  );
}

export function mergeEthereumProviderCandidates<
  TProvider extends EthereumProviderCandidate = EthereumProviderCandidate,
>() {
  const providers = getEthereumProviderCandidates<TProvider>();
  const merged = Object.assign(
    {},
    ...providers.slice().reverse()
  ) as TProvider;

  if (providers.some(isOkxEthereumProvider)) {
    merged.isOKXWallet = true;
  }

  return merged;
}

export function isOkxEthereumProvider(provider: EthereumProviderCandidate) {
  if (knownOkxProviders.has(provider)) {
    return true;
  }

  if (provider.isOKExWallet || provider.isOKXWallet || provider.isOkxWallet) {
    return true;
  }

  const signal = [
    provider.info?.name,
    provider.info?.rdns,
    provider.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return signal.includes("okx") || signal.includes("okex");
}

export function hasInjectedOkxWallet() {
  return getEthereumProviderCandidates().some(isOkxEthereumProvider);
}

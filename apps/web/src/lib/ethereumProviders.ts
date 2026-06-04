export type EthereumProviderCandidate = {
  isMetaMask?: boolean;
  isOKExWallet?: boolean;
  isOKXWallet?: boolean;
  isOkxWallet?: boolean;
  isTokenPocket?: boolean;
  info?: { name?: string; rdns?: string };
  name?: string;
  request?: unknown;
  providers?: EthereumProviderCandidate[];
  selectedProvider?: EthereumProviderCandidate;
};

const knownOkxProviders = new WeakSet<object>();
const knownTokenPocketProviders = new WeakSet<object>();

export function isOkxAppBrowser() {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /OKApp/i.test(navigator.userAgent || "");
}

export function isTokenPocketAppBrowser() {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /TokenPocket/i.test(navigator.userAgent || "");
}

export function getEthereumProviderCandidates<
  TProvider extends EthereumProviderCandidate = EthereumProviderCandidate,
>(): TProvider[] {
  if (typeof window === "undefined") {
    return [];
  }

  const browserWindow = window as Window & {
    ethereum?: TProvider;
    okxwallet?: TProvider;
    tokenpocket?: TProvider | { ethereum?: TProvider };
  };
  const ethereum = browserWindow.ethereum;
  const tokenPocketProvider =
    browserWindow.tokenpocket &&
    typeof browserWindow.tokenpocket === "object" &&
    "ethereum" in browserWindow.tokenpocket
      ? browserWindow.tokenpocket.ethereum
      : browserWindow.tokenpocket;
  if (browserWindow.okxwallet && typeof browserWindow.okxwallet === "object") {
    knownOkxProviders.add(browserWindow.okxwallet);
  }
  if (tokenPocketProvider && typeof tokenPocketProvider === "object") {
    knownTokenPocketProviders.add(tokenPocketProvider);
  }
  if (isOkxAppBrowser()) {
    for (const provider of [
      ethereum?.selectedProvider,
      ...(Array.isArray(ethereum?.providers) ? ethereum.providers : []),
      ethereum,
    ]) {
      if (provider && typeof provider === "object") {
        knownOkxProviders.add(provider);
      }
    }
  }
  if (isTokenPocketAppBrowser()) {
    for (const provider of [
      tokenPocketProvider,
      ethereum?.selectedProvider,
      ...(Array.isArray(ethereum?.providers) ? ethereum.providers : []),
      ethereum,
    ]) {
      if (provider && typeof provider === "object") {
        knownTokenPocketProviders.add(provider);
      }
    }
  }

  const candidates = [
    browserWindow.okxwallet,
    tokenPocketProvider,
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
  if (providers.some(isTokenPocketEthereumProvider)) {
    merged.isTokenPocket = true;
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

  if (isOkxAppBrowser() && typeof provider.request === "function") {
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

export function isTokenPocketEthereumProvider(provider: EthereumProviderCandidate) {
  if (knownTokenPocketProviders.has(provider)) {
    return true;
  }

  if (provider.isTokenPocket) {
    return true;
  }

  if (isTokenPocketAppBrowser() && typeof provider.request === "function") {
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

  return signal.includes("tokenpocket") || signal.includes("token_pocket");
}

export function hasInjectedTokenPocketWallet() {
  return getEthereumProviderCandidates().some(isTokenPocketEthereumProvider);
}

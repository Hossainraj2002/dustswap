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

function isMobileUserAgent() {
  if (typeof navigator === "undefined") {
    return false;
  }

  const userAgent = navigator.userAgent || "";
  const isIpadOS =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || isIpadOS;
}

// Bug #2: on a plain mobile browser the OKX option connects over WalletConnect,
// whose relay handshake is flaky/blocked (e.g. behind a VPN) and frequently
// stalls on Privy's "Waiting for OKX Wallet…" screen. The reliable path is to
// open the dApp inside OKX's own in-app browser, where OKX is injected and
// connects natively (detected_ethereum_wallets) with no relay involved.
// We use OKX's universal link so it launches the app when installed and falls
// back to the store otherwise. See OKX Wallet deep-link docs.
export function buildOkxInAppBrowserLink(targetUrl?: string) {
  const dappUrl =
    targetUrl ||
    (typeof window !== "undefined"
      ? window.location.href
      : "https://app.dustswap.wtf");
  const innerDeepLink = `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(dappUrl)}`;
  return `https://www.okx.com/download?deeplink=${encodeURIComponent(innerDeepLink)}`;
}

export function buildTokenPocketInAppBrowserLink(targetUrl?: string) {
  const dappUrl =
    targetUrl ||
    (typeof window !== "undefined"
      ? window.location.href
      : "https://app.dustswap.wtf");
  const params = {
    url: dappUrl,
    chain: "ETH",
    source: "DustSwap",
  };
  return `tpdapp://open?params=${encodeURIComponent(JSON.stringify(params))}`;
}

// Offer the OKX deep link only on a mobile browser that is NOT already the OKX
// (or another wallet's) in-app browser, where the native injected flow works.
export function shouldOfferOkxAppDeepLink() {
  return (
    isMobileUserAgent() && !isOkxAppBrowser() && !isTokenPocketAppBrowser()
  );
}

export function shouldOfferTokenPocketAppDeepLink() {
  return isMobileUserAgent() && !isTokenPocketAppBrowser();
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

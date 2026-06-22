export type EthereumProviderCandidate = {
  isBitgetWallet?: boolean;
  isBitKeep?: boolean;
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
const knownBitgetProviders = new WeakSet<object>();

type Eip6963ProviderInfo = {
  uuid?: string;
  name?: string;
  icon?: string;
  rdns?: string;
};

type Eip6963ProviderDetail<
  TProvider extends EthereumProviderCandidate = EthereumProviderCandidate,
> = {
  info?: Eip6963ProviderInfo;
  provider?: TProvider;
};

type Eip6963ProviderEvent<
  TProvider extends EthereumProviderCandidate = EthereumProviderCandidate,
> = Event & {
  detail?: Eip6963ProviderDetail<TProvider>;
};

type Eip6963Window = Window & {
  __dustSwapEip6963Listening?: boolean;
  __dustSwapEip6963Providers?: Eip6963ProviderDetail[];
};

function getEip6963Store() {
  if (typeof window === "undefined") {
    return [];
  }

  const browserWindow = window as Eip6963Window;
  browserWindow.__dustSwapEip6963Providers ||= [];

  if (!browserWindow.__dustSwapEip6963Listening) {
    browserWindow.addEventListener("eip6963:announceProvider", (rawEvent) => {
      const event = rawEvent as Eip6963ProviderEvent;
      const provider = event.detail?.provider;
      if (!provider || typeof provider !== "object") {
        return;
      }

      const info = event.detail?.info;
      if (info && !provider.info) {
        provider.info = info;
      }

      const providers = browserWindow.__dustSwapEip6963Providers || [];
      const alreadySeen = providers.some(
        (entry) =>
          entry.provider === provider ||
          (!!info?.uuid && entry.info?.uuid === info.uuid),
      );
      if (!alreadySeen) {
        providers.push({ info, provider });
      }
    });
    browserWindow.__dustSwapEip6963Listening = true;
  }

  try {
    browserWindow.dispatchEvent(new Event("eip6963:requestProvider"));
  } catch {
    // Older browsers or hardened extension contexts may reject the event.
  }

  return browserWindow.__dustSwapEip6963Providers || [];
}

function getEip6963Providers<
  TProvider extends EthereumProviderCandidate = EthereumProviderCandidate,
>() {
  return getEip6963Store()
    .map((entry) => {
      const provider = entry.provider as TProvider | undefined;
      if (provider && entry.info && !provider.info) {
        provider.info = entry.info;
      }
      return provider;
    })
    .filter(Boolean) as TProvider[];
}

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

export function isBitgetAppBrowser() {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /Bitget|BitKeep/i.test(navigator.userAgent || "");
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
    bitget?: TProvider | { ethereum?: TProvider };
    bitkeep?: TProvider | { ethereum?: TProvider };
    okxwallet?: TProvider;
    tokenpocket?: TProvider | { ethereum?: TProvider };
  };
  const ethereum = browserWindow.ethereum;
  const eip6963Providers = getEip6963Providers<TProvider>();
  const bitgetProvider =
    browserWindow.bitget &&
    typeof browserWindow.bitget === "object" &&
    "ethereum" in browserWindow.bitget
      ? browserWindow.bitget.ethereum
      : browserWindow.bitget;
  const bitkeepProvider =
    browserWindow.bitkeep &&
    typeof browserWindow.bitkeep === "object" &&
    "ethereum" in browserWindow.bitkeep
      ? browserWindow.bitkeep.ethereum
      : browserWindow.bitkeep;
  const tokenPocketProvider =
    browserWindow.tokenpocket &&
    typeof browserWindow.tokenpocket === "object" &&
    "ethereum" in browserWindow.tokenpocket
      ? browserWindow.tokenpocket.ethereum
      : browserWindow.tokenpocket;
  for (const provider of [bitgetProvider, bitkeepProvider]) {
    if (provider && typeof provider === "object") {
      knownBitgetProviders.add(provider);
    }
  }
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
  if (isBitgetAppBrowser()) {
    for (const provider of [
      bitgetProvider,
      bitkeepProvider,
      ethereum?.selectedProvider,
      ...(Array.isArray(ethereum?.providers) ? ethereum.providers : []),
      ethereum,
    ]) {
      if (provider && typeof provider === "object") {
        knownBitgetProviders.add(provider);
      }
    }
  }

  const candidates = [
    bitgetProvider,
    bitkeepProvider,
    browserWindow.okxwallet,
    tokenPocketProvider,
    ...eip6963Providers,
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
  if (providers.some(isBitgetEthereumProvider)) {
    merged.isBitgetWallet = true;
    merged.isBitKeep = true;
  }
  if (providers.some(isMetaMaskEthereumProvider)) {
    merged.isMetaMask = true;
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

export function isMetaMaskEthereumProvider(provider: EthereumProviderCandidate) {
  if (provider.isMetaMask) {
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

  return signal.includes("metamask") || signal.includes("meta_mask");
}

export function hasInjectedMetaMaskWallet() {
  return getEthereumProviderCandidates().some(isMetaMaskEthereumProvider);
}

export function isBitgetEthereumProvider(provider: EthereumProviderCandidate) {
  if (knownBitgetProviders.has(provider)) {
    return true;
  }

  if (provider.isBitgetWallet || provider.isBitKeep) {
    return true;
  }

  if (isBitgetAppBrowser() && typeof provider.request === "function") {
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

  return signal.includes("bitget") || signal.includes("bitkeep");
}

export function hasInjectedBitgetWallet() {
  return getEthereumProviderCandidates().some(isBitgetEthereumProvider);
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

// True when ANY injected EVM provider is present (window.ethereum, window.okxwallet,
// an EIP-6963 announcer, etc.). On mobile this is the reliable "are we inside a
// wallet's in-app browser?" signal: a plain Chrome/Safari injects nothing, while
// OKX/Bitget/Coinbase/MetaMask in-app browsers all inject a provider.
export function hasAnyInjectedEthereumProvider() {
  return getEthereumProviderCandidates().length > 0;
}

// Wait briefly for an injected EVM provider to appear. In-app wallet browsers —
// OKX especially — inject window.okxwallet and announce via EIP-6963 a few hundred
// ms AFTER the page loads, so reading providers synchronously at modal-open time
// misses them. Each poll re-dispatches eip6963:requestProvider (via
// getEthereumProviderCandidates → getEip6963Store), so a late announcer is still
// captured. Resolves true as soon as a provider exists, or false on timeout.
export async function waitForInjectedProvider(
  timeoutMs = 1200,
  stepMs = 100,
): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }
  if (hasAnyInjectedEthereumProvider()) {
    return true;
  }
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    if (hasAnyInjectedEthereumProvider()) {
      return true;
    }
  }
  return hasAnyInjectedEthereumProvider();
}

let okxEip6963ShimInstalled = false;
let okxEip6963Uuid: string | null = null;

function getOkxEip6963Uuid() {
  if (!okxEip6963Uuid) {
    okxEip6963Uuid =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `okx-${Math.random().toString(16).slice(2)}`;
  }
  return okxEip6963Uuid;
}

// OKX's mobile in-app browser injects `window.okxwallet` but does NOT announce
// itself via EIP-6963. Privy (and most modern wallet UIs) discover external
// wallets ONLY through EIP-6963, so Privy never surfaces the injected OKX and
// instead routes "OKX" through the WalletConnect relay — which stalls on
// "Waiting for OKX Wallet…" (the reported failure, worse behind a VPN). We
// announce the injected provider on EIP-6963's behalf so Privy detects it and
// connects to it natively (EIP-1193, no relay). Mobile-only (desktop OKX
// extension announces itself, so shimming there would just duplicate it); the
// uuid is stable so repeated announcements de-duplicate; a no-op when OKX isn't
// present. Call it early (once) and again right before opening the picker.
export function ensureOkxEip6963Shim() {
  if (
    typeof window === "undefined" ||
    okxEip6963ShimInstalled ||
    !isMobileUserAgent()
  ) {
    return;
  }
  okxEip6963ShimInstalled = true;

  const okxIcon = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 90"><rect width="90" height="90" rx="20" fill="#000"/><g fill="#fff"><rect x="18" y="18" width="18" height="18"/><rect x="54" y="18" width="18" height="18"/><rect x="36" y="36" width="18" height="18"/><rect x="18" y="54" width="18" height="18"/><rect x="54" y="54" width="18" height="18"/></g></svg>',
  )}`;

  const announce = () => {
    const browserWindow = window as Window & {
      okxwallet?: EthereumProviderCandidate;
      ethereum?: EthereumProviderCandidate;
    };
    const okxProvider =
      browserWindow.okxwallet ||
      (browserWindow.ethereum && isOkxEthereumProvider(browserWindow.ethereum)
        ? browserWindow.ethereum
        : undefined);
    if (!okxProvider || typeof okxProvider !== "object") {
      return;
    }
    try {
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze({
            info: {
              uuid: getOkxEip6963Uuid(),
              name: "OKX Wallet",
              icon: okxIcon,
              rdns: "com.okex.wallet",
            },
            provider: okxProvider,
          }),
        }),
      );
    } catch {
      // ignore — best effort
    }
  };

  // Answer any consumer (Privy) that requests providers, and announce now in
  // case a request already fired before this listener was installed.
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}

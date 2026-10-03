/**
 * Base App environment detection.
 *
 * The pin prompt must never appear outside Base App. A desktop user connecting
 * a Base Account through the keys.coinbase.com popup cannot pin anything, and a
 * MetaMask user has no notion of it at all, so showing them a prompt is pure
 * noise. This module is therefore deliberately strict: it would rather miss a
 * genuine Base App user than show the prompt to somebody who cannot act on it.
 *
 * Why not the Farcaster SDK: after 2026-04-09 the Base App treats every app as
 * a standard web app and no longer invokes the mini-app SDK, so `isInMiniApp`
 * and `context.client.clientFid` are not dependable signals. What remains true
 * is the shape of the environment itself: Base App renders the site in a mobile
 * in-app browser with a Coinbase-family EIP-1193 provider injected at
 * window.ethereum.
 *
 * All three signals below must hold.
 */

type Eip1193Like = {
  isCoinbaseWallet?: boolean;
  isCoinbaseBrowser?: boolean;
  isBaseApp?: boolean;
  providers?: Eip1193Like[];
};

export type BaseAppDetection = {
  isBaseApp: boolean;
  /** Which checks passed. Useful when debugging a device that will not prompt. */
  signals: {
    mobile: boolean;
    injectedCoinbaseProvider: boolean;
    coinbaseConnector: boolean;
  };
};

function getWindowEthereum(): Eip1193Like | null {
  if (typeof window === "undefined") {
    return null;
  }

  return (window as unknown as { ethereum?: Eip1193Like }).ethereum ?? null;
}

/**
 * Base App runs on phones only. This also rules out the desktop popup flow,
 * where a Base Account is connected but nothing is pinnable.
 */
function isMobileRuntime() {
  if (typeof navigator === "undefined") {
    return false;
  }

  const ua = navigator.userAgent || "";
  const iPadOs =
    navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1;

  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || iPadOs;
}

/**
 * An in-app browser injects its provider directly. The desktop Base Account
 * flow opens a popup instead and leaves window.ethereum untouched by Coinbase,
 * so this is what separates "inside the wallet app" from "connected to it".
 */
function hasInjectedCoinbaseProvider() {
  const ethereum = getWindowEthereum();
  if (!ethereum) {
    return false;
  }

  const candidates: Eip1193Like[] = [
    ethereum,
    ...(Array.isArray(ethereum.providers) ? ethereum.providers : []),
  ];

  return candidates.some(
    (provider) =>
      Boolean(provider?.isCoinbaseWallet) ||
      Boolean(provider?.isCoinbaseBrowser) ||
      Boolean(provider?.isBaseApp)
  );
}

/**
 * @param isCoinbaseSmartWallet from useWalletWhitelist, which already resolves
 *   the Privy connector id and wallet client type into a Base Account signal.
 */
export function detectBaseAppEnvironment(
  isCoinbaseSmartWallet: boolean
): BaseAppDetection {
  const mobile = isMobileRuntime();
  const injectedCoinbaseProvider = hasInjectedCoinbaseProvider();

  return {
    isBaseApp: mobile && injectedCoinbaseProvider && isCoinbaseSmartWallet,
    signals: {
      mobile,
      injectedCoinbaseProvider,
      coinbaseConnector: isCoinbaseSmartWallet,
    },
  };
}

/** Selected-provider metadata supplements chain code for undeployed smart accounts. */
const accounts = new WeakMap<object, { address: string; smartAccount: boolean }>();

export function rememberWalletAccount(connector: object, wallet: { address: string; walletClientType?: string }) {
  accounts.set(connector, {
    address: wallet.address.toLowerCase(),
    // Coinbase Wallet also serves EOAs; only these explicit smart-account types qualify.
    smartAccount: wallet.walletClientType === "base_account" || wallet.walletClientType === "coinbase_smart_wallet",
  });
}

export function requiresWalletAttribution(connector: object | undefined, address: string): boolean {
  const selected = connector && accounts.get(connector);
  return selected?.address === address.toLowerCase() && selected.smartAccount;
}

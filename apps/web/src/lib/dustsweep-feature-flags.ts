import { type DustSweepWalletKey } from "@/types/dustsweep";

export const METAMASK_APPROVAL_BATCHING_DISABLED_NOTICE =
  "MetaMask approval batching is disabled for safety. Approve tokens one by one, then DustSweep will send one sweep transaction.";

export const OKX_APPROVAL_BATCHING_DISABLED_NOTICE =
  "OKX Wallet approval batching is disabled so OKX can show each approval clearly. Approve tokens one by one, then DustSweep will send one sweep transaction.";

export const METAMASK_BATCH_APPROVALS_ENABLED =
  process.env.NEXT_PUBLIC_DUST_SWEEP_METAMASK_BATCH_APPROVALS === "true";

export const OKX_BATCH_APPROVALS_ENABLED =
  process.env.NEXT_PUBLIC_DUST_SWEEP_OKX_BATCH_APPROVALS === "true";

export const RAINBOW_ONE_CLICK_SWEEP_ENABLED =
  process.env.NEXT_PUBLIC_DUST_SWEEP_RAINBOW_ONE_CLICK === "true";

export const TRUST_ONE_CLICK_SWEEP_ENABLED =
  process.env.NEXT_PUBLIC_DUST_SWEEP_TRUST_ONE_CLICK === "true";

export function isDustSweepApprovalBatchingEnabled(
  walletKey?: DustSweepWalletKey | null,
) {
  if (walletKey === "metamask") {
    return METAMASK_BATCH_APPROVALS_ENABLED;
  }

  if (walletKey === "okx") {
    return OKX_BATCH_APPROVALS_ENABLED;
  }

  return true;
}

export function getDustSweepApprovalBatchingDisabledNotice(
  walletName?: string | null,
  walletKey?: DustSweepWalletKey | null,
) {
  if (walletKey === "metamask") {
    return METAMASK_APPROVAL_BATCHING_DISABLED_NOTICE;
  }

  if (walletKey === "okx") {
    return OKX_APPROVAL_BATCHING_DISABLED_NOTICE;
  }

  return `${walletName || "Wallet"} approval batching is disabled. Approve tokens one by one, then DustSweep will send one sweep transaction.`;
}

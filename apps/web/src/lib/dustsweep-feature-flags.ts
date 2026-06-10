import { type DustSweepWalletKey } from "@/types/dustsweep";

export const METAMASK_APPROVAL_BATCHING_DISABLED_NOTICE =
  "MetaMask approval batching is disabled for safety. Approve tokens one by one, then DustSweep will send one sweep transaction.";

export const METAMASK_BATCH_APPROVALS_ENABLED =
  process.env.NEXT_PUBLIC_DUST_SWEEP_METAMASK_BATCH_APPROVALS === "true";

export function isDustSweepApprovalBatchingEnabled(
  walletKey?: DustSweepWalletKey | null,
) {
  if (walletKey === "metamask") {
    return METAMASK_BATCH_APPROVALS_ENABLED;
  }

  return true;
}

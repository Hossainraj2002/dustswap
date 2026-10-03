"use client";

import { useWallet } from "@/lib/wallet/WalletProvider";
import { PageHeader } from "@/components/shell/PageHeader";
import { ConnectHint } from "@/components/shell/WalletButton";
import { ProfileScreen } from "@/components/profile/ProfileScreen";

/** The connected wallet's own profile. */
export default function MePage() {
  const wallet = useWallet();
  if (wallet.status === "connected" && wallet.address) return <ProfileScreen address={wallet.address} />;
  return (
    <>
      <PageHeader title="Profile" />
      <div className="mf-card">
        <ConnectHint action="see your coins, holdings and activity" />
      </div>
    </>
  );
}

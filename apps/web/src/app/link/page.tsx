import { WalletLinkConfirm } from "@/components/walletLink/WalletLinkConfirm";

// Direct link form: /link?token=… (used by the "Copy link" button / normal browsers).
export default async function WalletLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : null;
  return <WalletLinkConfirm token={token} />;
}

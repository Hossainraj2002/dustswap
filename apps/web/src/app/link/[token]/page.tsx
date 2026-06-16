import { WalletLinkConfirm } from "@/components/walletLink/WalletLinkConfirm";

// Base App deep-link form: /link/<token>. Base App preserves the path segment
// (but drops query strings), so the token rides in the path here.
export default async function WalletLinkTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <WalletLinkConfirm token={token ? decodeURIComponent(token) : null} />;
}

export const SWEEP_NETWORK_ICONS: Record<number, { src: string; label: string }> = {
  8453: { src: "/dex/base.png", label: "Base" },
  1: { src: "/dex/eth.png", label: "Ethereum" },
  56: { src: "/dex/bnb.png", label: "BNB Chain" },
  4663: { src: "/dex/robinhood.png", label: "Robinhood" },
  42161: { src: "/dex/arbitrum.png", label: "Arbitrum" },
  10: { src: "/dex/optimism.png", label: "Optimism" },
};

export function SweepNetworkIcon({
  chainId,
  className = "h-6 w-6",
  decorative = false,
}: {
  chainId: number;
  className?: string;
  decorative?: boolean;
}) {
  const network = SWEEP_NETWORK_ICONS[chainId];
  if (!network) return null;

  return (
    <img
      src={network.src}
      alt={decorative ? "" : network.label}
      aria-hidden={decorative || undefined}
      draggable={false}
      className={`shrink-0 object-contain ${className}`}
    />
  );
}

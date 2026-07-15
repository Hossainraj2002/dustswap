"use client";

import { useEffect, useMemo, useState } from "react";
import { type Token } from "@/types/dustsweep";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

// Deterministic per-chain logo CDN (DefiLlama token-icons), keyed by chainId + lowercased address.
// Mirrors the server-side fallback in apps/api. Used here as an extra client candidate so a token
// still renders a real icon when the server logo is missing OR its URL 404s (e.g. a dead
// DexScreener image). Unknown tokens 404 here too and cleanly fall through to the letter avatar.
const DETERMINISTIC_LOGO_CHAIN_IDS = new Set<number>([8453, 1, 56]);

function fallbackLogo(address: string | undefined, chainId: number): string | undefined {
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return undefined;
  if (!DETERMINISTIC_LOGO_CHAIN_IDS.has(chainId)) return undefined;
  return `https://token-icons.llamao.fi/icons/tokens/${chainId}/${address.toLowerCase()}?h=48&w=48`;
}

export function TokenLogo({
  token,
  size = "md",
  muted = false,
  chainId = 8453,
}: {
  token: Pick<Token, "symbol" | "logoURI" | "address">;
  size?: "sm" | "md" | "lg";
  muted?: boolean;
  chainId?: number;
}) {
  const sizeClass =
    size === "sm" ? "h-7 w-7 text-xs" : size === "lg" ? "h-12 w-12 text-base" : "h-9 w-9 text-sm";

  // Ordered, de-duped candidate srcs: server-provided logo first, then the deterministic CDN.
  // The <img> advances to the next candidate on error and shows the letter avatar once exhausted.
  const candidates = useMemo(() => {
    const list = [token.logoURI, fallbackLogo(token.address, chainId)].filter(
      (src): src is string => Boolean(src),
    );
    return Array.from(new Set(list));
  }, [token.logoURI, token.address, chainId]);

  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
  }, [candidates]);

  const src = candidates[index];

  if (src) {
    return (
      <span className={cx("relative inline-flex shrink-0", sizeClass)}>
        <img
          src={src}
          alt={token.symbol ? `${token.symbol} logo` : "Token logo"}
          onError={() => setIndex((current) => current + 1)}
          className={cx("h-full w-full rounded-full bg-slate-100 object-cover", muted && "grayscale")}
        />
        <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-[3px] border-2 border-white bg-blue-600" />
      </span>
    );
  }

  return (
    <span
      className={cx(
        "relative inline-flex shrink-0 items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-700",
        sizeClass,
        muted && "text-slate-400",
      )}
    >
      {token.symbol?.slice(0, 1) || "?"}
      <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-[3px] border-2 border-white bg-blue-600" />
    </span>
  );
}

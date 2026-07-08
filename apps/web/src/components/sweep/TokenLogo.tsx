"use client";

import { useEffect, useState } from "react";
import { type Token } from "@/types/dustsweep";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function TokenLogo({
  token,
  size = "md",
  muted = false,
}: {
  token: Pick<Token, "symbol" | "logoURI">;
  size?: "sm" | "md" | "lg";
  muted?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const sizeClass =
    size === "sm" ? "h-7 w-7 text-xs" : size === "lg" ? "h-12 w-12 text-base" : "h-9 w-9 text-sm";

  useEffect(() => {
    setImageFailed(false);
  }, [token.logoURI]);

  if (token.logoURI && !imageFailed) {
    return (
      <span className={cx("relative inline-flex shrink-0", sizeClass)}>
        <img
          src={token.logoURI}
          alt={token.symbol ? `${token.symbol} logo` : "Token logo"}
          onError={() => setImageFailed(true)}
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

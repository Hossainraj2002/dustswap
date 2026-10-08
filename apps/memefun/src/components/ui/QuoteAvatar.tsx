"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";
import type { QuoteAsset } from "@/core/types";
import { TARGET_CHAIN_ID } from "@/lib/chain";
import { pairIconSources } from "@/lib/market/pair-icons";

export function QuoteAvatar({ quote, size = 36 }: { quote: QuoteAsset; size?: number }) {
  const sources = pairIconSources(quote, TARGET_CHAIN_ID);
  // Remount after address or metadata changes so a failed old URL cannot hide a new image.
  return <QuoteImage key={JSON.stringify([quote.address.toLowerCase(), sources])} sources={sources} name={quote.symbol} size={size} />;
}

function QuoteImage({ sources, name, size }: { sources: string[]; name: string; size: number }) {
  const [index, setIndex] = useState(0);
  const src = sources[index];
  return <span className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-white" style={{ width: size, height: size }}>
    {src ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img key={src} src={src} alt={name + " logo"} width={size} height={size} loading="lazy" decoding="async" draggable={false}
        referrerPolicy="no-referrer" className="size-full object-contain" onError={() => setIndex(current => current + 1)} />
    ) : <span role="img" aria-label={name + " logo unavailable"} title="Logo unavailable" className="flex size-full items-center justify-center bg-fill-3 text-label-2">
      <ImageOff style={{ width: size * 0.5, height: size * 0.5 }} aria-hidden />
    </span>}
  </span>;
}

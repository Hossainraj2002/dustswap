"use client";

export type DataInvalidationScope =
  | "leaderboard"
  | "points"
  | "profile"
  | "quests";

export type DataInvalidationDetail = {
  reason?: string;
  scopes: DataInvalidationScope[];
};

const DATA_INVALIDATION_EVENT = "dustswap:data-invalidate";

function toScopes(scopes: DataInvalidationScope | DataInvalidationScope[]) {
  return [...new Set(Array.isArray(scopes) ? scopes : [scopes])];
}

export function emitDataInvalidation(
  scopes: DataInvalidationScope | DataInvalidationScope[],
  reason?: string
) {
  if (typeof window === "undefined") {
    return;
  }

  const normalizedScopes = toScopes(scopes);
  if (!normalizedScopes.length) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DataInvalidationDetail>(DATA_INVALIDATION_EVENT, {
      detail: {
        reason,
        scopes: normalizedScopes,
      },
    })
  );
}

export function subscribeToDataInvalidation(
  scope: DataInvalidationScope,
  listener: (detail: DataInvalidationDetail) => void
) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handler = (event: Event) => {
    const detail = (event as CustomEvent<DataInvalidationDetail>).detail;
    if (!detail?.scopes?.includes(scope)) {
      return;
    }

    listener(detail);
  };

  window.addEventListener(DATA_INVALIDATION_EVENT, handler as EventListener);
  return () => {
    window.removeEventListener(DATA_INVALIDATION_EVENT, handler as EventListener);
  };
}

// ── Swap referrer-tamper warning ────────────────────────────────────────────
// Fired when a browser extension (e.g. Pocket Universe) rewrote the OpenOcean
// referrer on a DustSwap swap — either blocked before signing (client guard) or
// detected on-chain after the fact (server `referrer_hijacked`). The swap page
// listens and shows a warning so the user can disable the extension.
export type SwapTamperDetail = {
  source: "pre_sign_block" | "onchain_detected";
  referrer?: string | null;
};

const SWAP_TAMPER_EVENT = "dustswap:swap-tamper";

export function emitSwapTamperWarning(detail: SwapTamperDetail) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<SwapTamperDetail>(SWAP_TAMPER_EVENT, { detail })
  );
}

export function subscribeToSwapTamperWarning(
  listener: (detail: SwapTamperDetail) => void
) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handler = (event: Event) => {
    listener((event as CustomEvent<SwapTamperDetail>).detail);
  };

  window.addEventListener(SWAP_TAMPER_EVENT, handler as EventListener);
  return () => {
    window.removeEventListener(SWAP_TAMPER_EVENT, handler as EventListener);
  };
}

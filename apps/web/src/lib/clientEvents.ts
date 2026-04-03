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

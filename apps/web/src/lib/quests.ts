import type {
  AdminManualPointsEntryInput,
  AdminManualPointsGrantResult,
  AdminQuestInput,
  QuestBoardResponse,
} from "@/types/quests";
import { buildPublicApiUrl } from "@/lib/apiBase";
import type { Hex } from "viem";

const SAVE_X_USERNAME_RECENT_TTL_MS = 15_000;
const START_QUEST_RECENT_TTL_MS = 15_000;
const X_ACCOUNT_STATEMENT = "DustSwap X Account Connection";
const saveXUsernameRecent = new Map<
  string,
  {
    expiresAt: number;
    value: {
      success: boolean;
      username?: string;
      error?: string;
    };
  }
>();
const saveXUsernameInflight = new Map<
  string,
  Promise<{
    success: boolean;
    username?: string;
    error?: string;
  }>
>();
const startQuestRecent = new Map<
  string,
  {
    expiresAt: number;
    value: {
      success: boolean;
      nextVerificationAt?: string;
      error?: string;
      idempotent?: boolean;
    };
  }
>();
const startQuestInflight = new Map<
  string,
  Promise<{
    success: boolean;
    nextVerificationAt?: string;
    error?: string;
    idempotent?: boolean;
  }>
>();

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function normalizeQuestsPath(path = "") {
  if (!path || path === "/") {
    return "/api/quests";
  }

  return `/api/quests${path.startsWith("/") ? path : `/${path}`}`;
}

export function getQuestsApiUrl(path = "") {
  return buildPublicApiUrl(normalizeQuestsPath(path));
}

function getSaveXUsernameCacheKey(address: string, username: string) {
  return `${address.toLowerCase()}:${username.trim().toLowerCase()}`;
}

function getStartQuestCacheKey(questId: string, address: string) {
  return `${questId}:${address.toLowerCase()}`;
}

function createNonce() {
  const browserCrypto =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;

  if (browserCrypto?.randomUUID) {
    return browserCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (browserCrypto?.getRandomValues) {
    browserCrypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export type XAccountAction = "connect-x" | "disconnect-x";

export function buildXAccountMessage(address: string, action: XAccountAction) {
  const domain =
    typeof window !== "undefined" ? window.location.host : "localhost:3000";

  return [
    X_ACCOUNT_STATEMENT,
    `Address: ${address}`,
    `Action: ${action}`,
    `Timestamp: ${new Date().toISOString()}`,
    `Nonce: ${createNonce()}`,
    `Domain: ${domain}`,
  ].join("\n");
}

export async function fetchQuestBoard(address?: string) {
  const url = new URL(getQuestsApiUrl());
  if (address) {
    url.searchParams.set("address", address);
  }

  const response = await fetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<QuestBoardResponse>(response);
}

export async function fetchXAccount(address: string) {
  const url = new URL(getQuestsApiUrl("/x/account"));
  url.searchParams.set("address", address);

  const response = await fetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<{
    success: boolean;
    account?: QuestBoardResponse["linkedAccounts"][string] | null;
    error?: string;
  }>(response);
}

export async function createXConnectUrl(input: {
  address: string;
  message: string;
  signature: Hex;
  returnTo?: string;
}) {
  const response = await fetch(getQuestsApiUrl("/x/connect"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return parseJson<{
    success: boolean;
    authUrl?: string;
    error?: string;
  }>(response);
}

export async function disconnectXAccount(input: {
  address: string;
  message: string;
  signature: Hex;
}) {
  const response = await fetch(getQuestsApiUrl("/x/disconnect"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return parseJson<{
    success: boolean;
    disconnected?: boolean;
    error?: string;
  }>(response);
}

export async function startQuest(questId: string, address: string) {
  const cacheKey = getStartQuestCacheKey(questId, address);
  const recent = startQuestRecent.get(cacheKey);

  if (recent && recent.expiresAt > Date.now()) {
    return recent.value;
  }

  if (recent) {
    startQuestRecent.delete(cacheKey);
  }

  const inflight = startQuestInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const request = fetch(getQuestsApiUrl(`/${questId}/start`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address }),
  })
    .then((response) =>
      parseJson<{
        success: boolean;
        nextVerificationAt?: string;
        error?: string;
        idempotent?: boolean;
      }>(response)
    )
    .then((data) => {
      if (data.success) {
        startQuestRecent.set(cacheKey, {
          expiresAt: Date.now() + START_QUEST_RECENT_TTL_MS,
          value: data,
        });
      }

      return data;
    })
    .finally(() => {
      startQuestInflight.delete(cacheKey);
    });

  startQuestInflight.set(cacheKey, request);
  return request;
}

export async function verifyDelayQuest(questId: string, address: string) {
  const response = await fetch(getQuestsApiUrl(`/${questId}/verify-delay`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address }),
  });

  return parseJson<{
    success: boolean;
    status?: string;
    remainingSeconds?: number;
    awardedPoints?: number;
    message?: string;
    error?: string;
  }>(response);
}

export async function verifyXPost(
  questId: string,
  address: string,
  postUrl: string
) {
  const response = await fetch(getQuestsApiUrl(`/${questId}/verify-x-post`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address, postUrl }),
  });

  return parseJson<{
    success: boolean;
    status?: string;
    awardedPoints?: number;
    error?: string;
  }>(response);
}

/**
 * @deprecated Legacy quest-side swap capture route. New clients should use
 * /api/swaps/record; the backend derives amount/token data from the transaction.
 */
export async function recordSwapQuestActivity(input: {
  address: string;
  txHash: string;
  chainId: number;
  amountUsd: number;
  inputToken?: string | null;
  outputToken?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const response = await fetch(getQuestsApiUrl("/activities/swap"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return parseJson<{
    success: boolean;
    completedQuests?: Array<{ questId: string; slug: string; awardedPoints: number }>;
    error?: string;
  }>(response);
}

export async function syncSwapQuestActivity(
  address: string,
  options?: { force?: boolean }
) {
  const response = await fetch(getQuestsApiUrl("/activities/swap/sync"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address, force: options?.force ?? false }),
  });

  return parseJson<{
    success: boolean;
    importedHashes?: string[];
    completedQuests?: Array<{ questId: string; slug: string; awardedPoints: number }>;
    error?: string;
  }>(response);
}

export async function saveXUsername(address: string, username: string) {
  const cacheKey = getSaveXUsernameCacheKey(address, username);
  const recent = saveXUsernameRecent.get(cacheKey);

  if (recent && recent.expiresAt > Date.now()) {
    return recent.value;
  }

  if (recent) {
    saveXUsernameRecent.delete(cacheKey);
  }

  const inflight = saveXUsernameInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const request = fetch(getQuestsApiUrl("/x/username"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address, username }),
  })
    .then((response) =>
      parseJson<{
        success: boolean;
        username?: string;
        error?: string;
      }>(response)
    )
    .then((data) => {
      if (data.success) {
        saveXUsernameRecent.set(cacheKey, {
          expiresAt: Date.now() + SAVE_X_USERNAME_RECENT_TTL_MS,
          value: data,
        });
      }

      return data;
    })
    .finally(() => {
      saveXUsernameInflight.delete(cacheKey);
    });

  saveXUsernameInflight.set(cacheKey, request);
  return request;
}

export async function fetchAdminQuests(adminToken: string) {
  const response = await fetch(getQuestsApiUrl("/admin"), {
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": adminToken,
    },
    cache: "no-store",
  });

  return parseJson<{
    success: boolean;
    data?: any[];
    error?: string;
  }>(response);
}

export async function fetchAdminCampaignWhitelist(
  adminToken: string,
  campaignKey: string
) {
  const response = await fetch(
    getQuestsApiUrl(`/admin/campaigns/${encodeURIComponent(campaignKey)}/whitelist`),
    {
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      cache: "no-store",
    }
  );

  return parseJson<{
    success: boolean;
    data?: Array<{
      id: number;
      campaign_key: string;
      user_id: number;
      wallet_address: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>;
    error?: string;
  }>(response);
}

export async function saveAdminQuest(adminToken: string, input: AdminQuestInput) {
  const response = await fetch(getQuestsApiUrl("/admin"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": adminToken,
    },
    body: JSON.stringify(input),
  });

  return parseJson<{
    success: boolean;
    data?: any;
    error?: string;
  }>(response);
}

export async function grantAdminManualPoints(
  adminToken: string,
  input: {
    entries: AdminManualPointsEntryInput[];
    note?: string;
    requestId: string;
    source?: string;
  }
) {
  const response = await fetch(getQuestsApiUrl("/admin/manual-points"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": adminToken,
    },
    body: JSON.stringify(input),
  });

  return parseJson<{
    success: boolean;
    data?: AdminManualPointsGrantResult;
    error?: string;
  }>(response);
}

export async function deleteAdminQuest(adminToken: string, id: string) {
  const response = await fetch(getQuestsApiUrl(`/admin/${id}`), {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": adminToken,
    },
  });

  return parseJson<{
    success: boolean;
    error?: string;
  }>(response);
}

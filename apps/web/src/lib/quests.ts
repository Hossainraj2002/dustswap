import type { AdminQuestInput, QuestBoardResponse } from "@/types/quests";

const DEFAULT_API_URL = "http://localhost:3001";

function normalizeApiOrigin(value: string) {
  return value.replace(/\/+$/, "").replace(/\/api$/, "");
}

function getApiOrigin() {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return normalizeApiOrigin(process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL);
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export function getQuestsApiUrl(path = "") {
  return `${getApiOrigin()}/api/quests${path}`;
}

export async function fetchQuestBoard(address?: string) {
  const url = new URL(getQuestsApiUrl("/"));
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

export async function startQuest(questId: string, address: string) {
  const response = await fetch(getQuestsApiUrl(`/${questId}/start`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address }),
  });

  return parseJson<{
    success: boolean;
    nextVerificationAt?: string;
    error?: string;
  }>(response);
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

export async function syncSwapQuestActivity(address: string) {
  const response = await fetch(getQuestsApiUrl("/activities/swap/sync"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address }),
  });

  return parseJson<{
    success: boolean;
    importedHashes?: string[];
    completedQuests?: Array<{ questId: string; slug: string; awardedPoints: number }>;
    error?: string;
  }>(response);
}

export function buildXConnectUrl(address: string, returnTo: string) {
  const url = new URL(getQuestsApiUrl("/x/connect"));
  url.searchParams.set("address", address);
  url.searchParams.set("returnTo", returnTo);
  return url.toString();
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

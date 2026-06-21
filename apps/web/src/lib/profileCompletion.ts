import type { Hex } from "viem";
import { buildPublicApiUrl, publicApiFetch } from "@/lib/apiBase";
import { authedApiFetch } from "@/lib/siweAuth";

export type ProfileCompletionStepKey =
  | "add_referral"
  | "connect_x"
  | "connect_discord";
export type ProfileCompletionNextStep =
  | ProfileCompletionStepKey
  | "claim_reward"
  | null;
export type ProfileCompletionGuide = {
  key: "profile_complete";
  version: 1;
  completionPercent: number;
  completedSteps: number;
  totalSteps: 3;
  nextStep: ProfileCompletionNextStep;
  rewardClaimed: boolean;
  canClaimReward: boolean;
  showModal: boolean;
  steps: Array<{
    key: ProfileCompletionStepKey;
    label: string;
    status: "complete" | "incomplete";
  }>;
};

export type ProfileCompletionResponse = {
  success: boolean;
  guide: ProfileCompletionGuide;
  error?: string;
};

export type ProfileCompletionClaimAction = "claim-profile-completion";

const PROFILE_COMPLETION_STATEMENT = "DustSwap Profile Completion";

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
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

export function getProfileCompletionApiUrl(path = "") {
  const normalizedPath =
    path && path !== "/" ? (path.startsWith("/") ? path : `/${path}`) : "";

  return buildPublicApiUrl(`/api/profile-completion${normalizedPath}`);
}

export function buildProfileCompletionMessage(
  address: string,
  action: ProfileCompletionClaimAction = "claim-profile-completion"
) {
  const domain =
    typeof window !== "undefined" ? window.location.host : "localhost:3000";

  return [
    PROFILE_COMPLETION_STATEMENT,
    `Address: ${address}`,
    `Action: ${action}`,
    `Timestamp: ${new Date().toISOString()}`,
    `Nonce: ${createNonce()}`,
    `Domain: ${domain}`,
  ].join("\n");
}

export async function fetchProfileCompletion(address: string) {
  const url = new URL(getProfileCompletionApiUrl("/"));
  url.searchParams.set("address", address);

  const response = await publicApiFetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  const data = await parseJson<ProfileCompletionResponse>(response);
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Failed to load profile completion.");
  }

  return data;
}

export async function recordProfileCompletionImpression(input: {
  address: string;
  surface?: "tracker" | "modal";
}) {
  const response = await authedApiFetch(getProfileCompletionApiUrl("/impression"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return parseJson<ProfileCompletionResponse>(response);
}

export async function dismissProfileCompletion(address: string) {
  const response = await authedApiFetch(getProfileCompletionApiUrl("/dismiss"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address }),
  });

  return parseJson<ProfileCompletionResponse>(response);
}

export async function claimProfileCompletionReward(input: {
  address: string;
  message: string;
  signature: Hex;
}) {
  const response = await publicApiFetch(getProfileCompletionApiUrl("/claim"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  const data = await parseJson<
    | (ProfileCompletionResponse & {
        totalPoints?: number;
        rewardClaimed?: boolean;
        canClaimReward?: boolean;
        claimedAt?: string | null;
      })
    | {
        success: false;
        error?: string;
        rewardClaimed?: boolean;
        canClaimReward?: boolean;
        guide?: ProfileCompletionGuide;
      }
  >(response);

  if (!response.ok || !data.success) {
    const error = "error" in data ? data.error : "Failed to claim profile completion reward.";
    const claimError = new Error(error || "Failed to claim profile completion reward.");
    Object.assign(claimError, { payload: data, status: response.status });
    throw claimError;
  }

  return data;
}

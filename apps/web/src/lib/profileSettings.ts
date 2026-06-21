import type { Hex } from "viem";
import {
  buildPublicApiUrl,
  getPublicApiOrigin,
  publicApiFetch,
} from "@/lib/apiBase";
import { authedApiFetch } from "@/lib/siweAuth";

export type ProfileSettingsAction = "save-profile" | "pfp-upload-url";

export type ProfileSettingsProfile = {
  address: string;
  username: string | null;
  displayName: string | null;
  discordUsername: string | null;
  pfpUrl: string | null;
  pfpStorageKey: string | null;
  xUsername: string | null;
  xUserId: string | null;
  xName: string | null;
  xAvatar: string | null;
  xConnected: boolean;
  xConnectedAt: string | null;
  xLegacyManual: boolean;
  discordAccount: {
    username?: string | null;
    platformUserId?: string | null;
    discordUserId?: string | null;
    displayName?: string | null;
    profileImageUrl?: string | null;
    connected?: boolean;
    connectedAt?: string | null;
    guildId?: string | null;
    joined?: boolean;
    pending?: boolean | null;
    joinedAt?: string | null;
    verifiedAt?: string | null;
    roles?: string[];
  } | null;
  source: "custom" | "fallback" | "wallet";
  custom: {
    username: string | null;
    displayName: string | null;
    discordUsername: string | null;
    pfpUrl: string | null;
    pfpStorageKey: string | null;
  };
  fallback: {
    username: string | null;
    displayName: string | null;
    pfpUrl: string | null;
  };
};

export type ProfileSettingsResponse = {
  success: boolean;
  profile: ProfileSettingsProfile;
  capabilities: {
    pfpUploadAvailable: boolean;
    missingR2EnvVars?: string[];
    pfpUploadUnavailableReason?: string | null;
  };
  savedXUsername?: string | null;
  error?: string;
};

export type PfpUploadUrlResponse = {
  success: boolean;
  uploadUrl?: string;
  publicUrl?: string;
  storageKey?: string;
  error?: string;
};

export type ProfileDisplaySource = {
  username?: string | null;
  display_name?: string | null;
  pfp_url?: string | null;
};

export type ResolvedProfileDisplay = {
  displayName: string;
  subtitle: string;
  avatarUrl: string;
  initials: string;
};

const PROFILE_SETTINGS_STATEMENT = "DustSwap Profile Settings";
const MAX_PFP_BYTES = 1024 * 1024;
const ALLOWED_PFP_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function parseJson<T>(response: Response): Promise<T> {
  return response.text().then((text) => (text ? JSON.parse(text) : {}));
}

function getProfileSettingsApiUrl(path = "") {
  const normalizedPath =
    path && path !== "/" ? (path.startsWith("/") ? path : `/${path}`) : "";

  return buildPublicApiUrl(
    `/api/profile-settings${normalizedPath}`
  );
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

export function buildProfileSettingsMessage(
  address: string,
  action: ProfileSettingsAction
) {
  const domain =
    typeof window !== "undefined" ? window.location.host : "localhost:3000";

  return [
    PROFILE_SETTINGS_STATEMENT,
    `Address: ${address}`,
    `Action: ${action}`,
    `Timestamp: ${new Date().toISOString()}`,
    `Nonce: ${createNonce()}`,
    `Domain: ${domain}`,
  ].join("\n");
}

export function shortAddress(address?: string | null) {
  if (!address) {
    return "Wallet";
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function getWalletInitials(label?: string | null) {
  const value = String(label || "").trim();
  if (!value || value.toLowerCase().startsWith("0x")) {
    return "0x";
  }

  const letters = value
    .replace(/^@+/, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");

  return letters && letters !== "0" ? letters : "0x";
}

export function normalizeProfileUsername(value: string) {
  return value.trim().toLowerCase().replace(/^@+/, "");
}

export function normalizeDisplayName(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeXUsername(value: string) {
  return value.trim().replace(/^@+/, "");
}

export function validateProfileUsername(value: string) {
  const normalized = normalizeProfileUsername(value);
  if (!normalized) {
    return null;
  }

  if (!/^[a-z0-9._]{3,24}$/.test(normalized)) {
    return "Username can use letters, numbers, underscore, or dot.";
  }

  return null;
}

export function validateDisplayName(value: string) {
  const normalized = normalizeDisplayName(value);
  if (!normalized) {
    return null;
  }

  if (normalized.length < 2 || normalized.length > 32) {
    return "Display name must be 2-32 characters.";
  }

  return null;
}

export function validateDiscordUsername(value: string) {
  const normalized = normalizeDisplayName(value);
  if (!normalized) {
    return null;
  }

  if (normalized.length < 2 || normalized.length > 40) {
    return "Discord username must be 2-40 characters.";
  }

  return null;
}

export function validateXUsername(value: string) {
  const normalized = normalizeXUsername(value);
  if (!normalized) {
    return null;
  }

  if (/https?:\/\//i.test(normalized) || normalized.includes("/") || /\s/.test(normalized)) {
    return "Enter a valid X username.";
  }

  if (!/^[A-Za-z0-9_]{1,15}$/.test(normalized)) {
    return "Enter a valid X username.";
  }

  return null;
}

export function validatePfpFile(file: File) {
  if (file.size > MAX_PFP_BYTES) {
    return "Image must be under 1 MB.";
  }

  if (!ALLOWED_PFP_TYPES.has(file.type)) {
    return "Only PNG, JPG, JPEG, or WEBP allowed.";
  }

  return null;
}

export function resolveProfileDisplay(input: {
  settings?: ProfileSettingsResponse | null;
  neynarProfile?: ProfileDisplaySource | null;
  address?: string | null;
}): ResolvedProfileDisplay {
  const custom = input.settings?.profile.custom;
  const fallback = input.settings?.profile.fallback;
  const neynar = input.neynarProfile;
  const displayName =
    custom?.displayName ||
    custom?.username ||
    fallback?.displayName ||
    fallback?.username ||
    neynar?.display_name ||
    neynar?.username ||
    shortAddress(input.address);
  const username =
    custom?.username ||
    fallback?.username ||
    neynar?.username ||
    null;
  const avatarUrl =
    custom?.pfpUrl || fallback?.pfpUrl || neynar?.pfp_url || "";

  return {
    displayName,
    subtitle: username ? `@${username}` : shortAddress(input.address),
    avatarUrl,
    initials: getWalletInitials(username || displayName || input.address),
  };
}

export async function fetchProfileSettings(
  address: string,
  options?: { adminToken?: string }
) {
  const url = new URL(getProfileSettingsApiUrl("/"));
  url.searchParams.set("address", address);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options?.adminToken) {
    headers["x-admin-token"] = options.adminToken;
  }

  let response: Response;
  try {
    response = await authedApiFetch(url.toString(), {
      headers,
      cache: "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network request failed";
    throw new Error(`Could not reach profile API at ${getPublicApiOrigin()}. ${message}`);
  }

  const data = await parseJson<ProfileSettingsResponse>(response);
  if (!response.ok || !data.success) {
    throw new Error(
      data.error ||
        `Profile API returned ${response.status} ${response.statusText || ""}`.trim()
    );
  }

  return data;
}

export async function requestPfpUploadUrl(input: {
  address: string;
  message: string;
  signature: Hex;
  file: File;
}) {
  const response = await publicApiFetch(getProfileSettingsApiUrl("/pfp-upload-url"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      address: input.address,
      message: input.message,
      signature: input.signature,
      fileName: input.file.name,
      contentType: input.file.type,
      size: input.file.size,
    }),
  });

  const data = await parseJson<PfpUploadUrlResponse>(response);
  if (!response.ok || !data.success || !data.uploadUrl || !data.publicUrl || !data.storageKey) {
    throw new Error(data.error || "PFP upload is temporarily unavailable.");
  }

  return {
    uploadUrl: data.uploadUrl,
    publicUrl: data.publicUrl,
    storageKey: data.storageKey,
  };
}

export async function uploadPfpFile(input: {
  uploadUrl: string;
  file: File;
}) {
  const response = await fetch(input.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": input.file.type,
    },
    body: input.file,
  });

  if (!response.ok) {
    throw new Error("Failed to upload PFP.");
  }
}

export async function saveProfileSettings(input: {
  address: string;
  message: string;
  signature: Hex;
  username?: string | null;
  displayName?: string | null;
  discordUsername?: string | null;
  pfpUrl?: string | null;
  pfpStorageKey?: string | null;
  xUsername?: string | null;
}) {
  const response = await publicApiFetch(getProfileSettingsApiUrl("/"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  const data = await parseJson<ProfileSettingsResponse>(response);
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Failed to save profile.");
  }

  return data;
}

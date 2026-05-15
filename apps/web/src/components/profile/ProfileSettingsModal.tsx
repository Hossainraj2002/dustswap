"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSignMessage } from "wagmi";
import type { Hex } from "viem";
import {
  buildProfileSettingsMessage,
  normalizeDisplayName,
  normalizeProfileUsername,
  requestPfpUploadUrl,
  saveProfileSettings,
  uploadPfpFile,
  validateDisplayName,
  validatePfpFile,
  validateProfileUsername,
  fetchProfileSettings,
  type ProfileSettingsResponse,
} from "@/lib/profileSettings";
import {
  buildDiscordAccountMessage,
  buildXAccountMessage,
  createXConnectUrl,
  disconnectXAccount,
  getDiscordConnectUrl,
  verifyDiscordJoin,
} from "@/lib/quests";

type ProfileSettingsModalProps = {
  open: boolean;
  address?: string;
  profileSettings: ProfileSettingsResponse | null;
  isProfileSettingsLoading?: boolean;
  profileSettingsError?: string | null;
  onRetryLoad?: () => void;
  onClose: () => void;
  onSaved: (settings: ProfileSettingsResponse) => void;
  initialSection?: ProfileSettingsInitialSection;
  initialFocusTarget?: ProfileSettingsFocusTarget | null;
  connectionSource?: string | null;
};

export type ProfileSettingsInitialSection = "profile" | "connections";
export type ProfileSettingsFocusTarget = "x_connection" | "discord_connection";

const MAX_PFP_BYTES = 1024 * 1024;

function formatFileSize(bytes: number) {
  if (!bytes) {
    return "0 KB";
  }

  if (bytes >= MAX_PFP_BYTES) {
    return `${(bytes / MAX_PFP_BYTES).toFixed(2)} MB`;
  }

  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function getDiscordDisplayName(
  account?: ProfileSettingsResponse["profile"]["discordAccount"]
) {
  return account?.displayName || account?.username || "Discord connected";
}

function getDiscordStatusLabel(
  account?: ProfileSettingsResponse["profile"]["discordAccount"]
) {
  if (!account?.connected) {
    return "Not connected";
  }

  if (account.joined === true) {
    return "Joined Discord verified";
  }

  return "Not joined yet";
}

function getDiscordVerifyMessage(error?: string | null) {
  if (error === "DISCORD_NOT_CONNECTED") {
    return "Connect Discord first.";
  }

  if (error === "DISCORD_USER_NOT_IN_GUILD") {
    return "Join our Discord, then verify again.";
  }

  if (error === "DISCORD_RATE_LIMITED") {
    return "Verification is rate limited. Try again shortly.";
  }

  return "Discord verification is temporarily unavailable.";
}

function getDiscordConnectMessage(error?: string | null) {
  if (!error) {
    return "Discord connection failed. Please try again.";
  }

  if (error === "DISCORD_OAUTH_STATE_INVALID") {
    return "Discord connection expired. Please try again.";
  }

  if (error === "DISCORD_OAUTH_EXCHANGE_FAILED") {
    return "Discord connection failed. Check the Discord app secret and redirect URL in Railway.";
  }

  if (error === "DISCORD_NOT_CONFIGURED") {
    return "Discord is not configured on the API server.";
  }

  return getDiscordVerifyMessage(error);
}

export function ProfileSettingsModal({
  open,
  address,
  profileSettings,
  isProfileSettingsLoading = false,
  profileSettingsError,
  onRetryLoad,
  onClose,
  onSaved,
  initialSection = "profile",
  initialFocusTarget = null,
  connectionSource,
}: ProfileSettingsModalProps) {
  const { signMessageAsync } = useSignMessage();
  const profile = profileSettings?.profile;
  const discordAccount = profile?.discordAccount;
  const discordInviteUrl = process.env.NEXT_PUBLIC_DISCORD_INVITE_URL || "";
  const uploadAvailable =
    profileSettings?.capabilities.pfpUploadAvailable ?? false;
  const missingR2EnvVars = profileSettings?.capabilities.missingR2EnvVars ?? [];
  const uploadUnavailableMessage = profileSettings
    ? missingR2EnvVars.length > 0
      ? `PFP upload is temporarily unavailable. Missing API env: ${missingR2EnvVars.join(", ")}.`
      : profileSettings.capabilities.pfpUploadUnavailableReason ||
        "PFP upload is temporarily unavailable."
    : isProfileSettingsLoading
      ? "Loading profile settings from the API..."
      : profileSettingsError ||
        (!address
          ? "Wallet address is not available yet. Reconnect your wallet and try again."
          : null) ||
        "Profile settings did not load from the API. Check NEXT_PUBLIC_API_URL and API CORS.";
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [xActionState, setXActionState] = useState<"idle" | "connecting" | "disconnecting">("idle");
  const [discordActionState, setDiscordActionState] = useState<
    "idle" | "connecting" | "verifying"
  >("idle");
  const [highlightTarget, setHighlightTarget] =
    useState<ProfileSettingsFocusTarget | null>(null);
  const connectionsSectionRef = useRef<HTMLDivElement>(null);
  const xCardRef = useRef<HTMLDivElement>(null);
  const discordCardRef = useRef<HTMLDivElement>(null);

  const initialPreviewUrl =
    profile?.custom.pfpUrl || profile?.fallback.pfpUrl || "";
  const currentPreviewUrl = previewUrl || initialPreviewUrl;

  useEffect(() => {
    if (!open) {
      return;
    }

    const fallbackUsername = normalizeProfileUsername(profile?.fallback.username || "");
    setUsername(
      profile?.custom.username ||
        (fallbackUsername && !validateProfileUsername(fallbackUsername)
          ? fallbackUsername
          : "")
    );
    setDisplayName(
      profile?.custom.displayName || profile?.fallback.displayName || ""
    );
    setSelectedFile(null);
    setPreviewUrl("");
    setFieldError(null);
    setStatusMessage(null);
  }, [open, profile]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving) {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSaving, onClose, open]);

  useEffect(() => {
    return () => {
      if (previewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    if (!open || !address) {
      return;
    }

    const handleDiscordOAuthMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const payload = event.data as {
        type?: string;
        success?: boolean;
        error?: string | null;
        username?: string | null;
      };

      if (payload?.type !== "dustswap:discord-oauth") {
        return;
      }

      setDiscordActionState("idle");
      if (!payload.success) {
        setFieldError(getDiscordConnectMessage(payload.error));
        return;
      }

      setStatusMessage(
        payload.username
          ? `Discord connected as ${payload.username}.`
          : "Discord connected."
      );
      void fetchProfileSettings(address)
        .then(onSaved)
        .catch((error) =>
          setFieldError((error as Error).message || "Failed to refresh profile.")
        );
    };

    window.addEventListener("message", handleDiscordOAuthMessage);
    return () => window.removeEventListener("message", handleDiscordOAuthMessage);
  }, [address, onSaved, open]);

  useEffect(() => {
    if (!open) {
      setHighlightTarget(null);
      return;
    }

    if (initialSection !== "connections") {
      return;
    }

    const targetElement =
      initialFocusTarget === "discord_connection"
        ? discordCardRef.current
        : initialFocusTarget === "x_connection"
          ? xCardRef.current
          : connectionsSectionRef.current;

    const scrollTimer = window.setTimeout(() => {
      targetElement?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });

      if (initialFocusTarget) {
        setHighlightTarget(initialFocusTarget);
        targetElement?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    }, 80);

    const clearHighlightTimer = initialFocusTarget
      ? window.setTimeout(() => {
          setHighlightTarget((current) =>
            current === initialFocusTarget ? null : current
          );
        }, 2200)
      : null;

    return () => {
      window.clearTimeout(scrollTimer);
      if (clearHighlightTimer) {
        window.clearTimeout(clearHighlightTimer);
      }
    };
  }, [initialFocusTarget, initialSection, open]);

  const validationMessage = useMemo(() => {
    return (
      validateProfileUsername(username) ||
      validateDisplayName(displayName)
    );
  }, [displayName, username]);

  function buildConnectionReturnTo(target: ProfileSettingsFocusTarget) {
    if (typeof window === "undefined") {
      return "/profile";
    }

    const returnTo = new URL("/profile", window.location.origin);
    returnTo.searchParams.set("open_settings", "1");
    returnTo.searchParams.set("settings_section", "connections");
    returnTo.searchParams.set("settings_focus", target);
    if (connectionSource) {
      returnTo.searchParams.set("settings_source", connectionSource);
    }

    return returnTo.toString();
  }

  if (!open) {
    return null;
  }

  function handleFileSelect(file: File | null) {
    setFieldError(null);
    setStatusMessage(null);

    if (!file) {
      setSelectedFile(null);
      setPreviewUrl("");
      return;
    }

    const error = validatePfpFile(file);
    if (error) {
      setFieldError(error);
      setSelectedFile(null);
      setPreviewUrl("");
      return;
    }

    setSelectedFile(file);
    setPreviewUrl((current) => {
      if (current.startsWith("blob:")) {
        URL.revokeObjectURL(current);
      }

      return URL.createObjectURL(file);
    });
  }

  async function handleSave() {
    if (!address || isSaving) {
      return;
    }

    const nextError = validationMessage;
    if (nextError) {
      setFieldError(nextError);
      return;
    }

    setIsSaving(true);
    setFieldError(null);
    setStatusMessage(null);

    try {
      let pfpUrl: string | null | undefined;
      let pfpStorageKey: string | null | undefined;

      if (selectedFile) {
        if (!uploadAvailable) {
          throw new Error("PFP upload is temporarily unavailable.");
        }

        setStatusMessage("Preparing PFP upload...");
        const uploadMessage = buildProfileSettingsMessage(
          address,
          "pfp-upload-url"
        );
        const uploadSignature = (await signMessageAsync({
          message: uploadMessage,
        })) as Hex;
        const upload = await requestPfpUploadUrl({
          address,
          message: uploadMessage,
          signature: uploadSignature,
          file: selectedFile,
        });

        setStatusMessage("Uploading PFP...");
        await uploadPfpFile({
          uploadUrl: upload.uploadUrl,
          file: selectedFile,
        });

        pfpUrl = upload.publicUrl;
        pfpStorageKey = upload.storageKey;
      }

      setStatusMessage("Saving profile...");
      const saveMessage = buildProfileSettingsMessage(address, "save-profile");
      const saveSignature = (await signMessageAsync({
        message: saveMessage,
      })) as Hex;
      const saved = await saveProfileSettings({
        address,
        message: saveMessage,
        signature: saveSignature,
        username: normalizeProfileUsername(username),
        displayName: normalizeDisplayName(displayName),
        pfpUrl,
        pfpStorageKey,
      });

      onSaved(saved);
    } catch (error) {
      setFieldError((error as Error).message || "Failed to save profile.");
    } finally {
      setStatusMessage(null);
      setIsSaving(false);
    }
  }

  async function handleConnectX() {
    if (!address || !profileSettings || xActionState !== "idle") {
      return;
    }

    setFieldError(null);
    setStatusMessage(null);
    setXActionState("connecting");

    try {
      const messageToSign = buildXAccountMessage(address, "connect-x");
      const signature = (await signMessageAsync({
        message: messageToSign,
      })) as Hex;
      const returnTo = buildConnectionReturnTo("x_connection");
      const response = await createXConnectUrl({
        address,
        message: messageToSign,
        signature,
        returnTo,
      });

      if (!response.success || !response.authUrl) {
        throw new Error(response.error || "Failed to start X connection.");
      }

      window.location.assign(response.authUrl);
    } catch (error) {
      setFieldError((error as Error).message || "Failed to connect X.");
      setXActionState("idle");
    }
  }

  async function handleConnectDiscord() {
    if (!address || !profileSettings || discordActionState !== "idle") {
      return;
    }

    setFieldError(null);
    setStatusMessage("Approve the wallet signature first. Discord will open automatically.");
    setDiscordActionState("connecting");

    try {
      const messageToSign = buildDiscordAccountMessage(address, "connect-discord");
      const signature = (await signMessageAsync({
        message: messageToSign,
      })) as Hex;
      const returnTo = buildConnectionReturnTo("discord_connection");
      const authUrl = getDiscordConnectUrl({
        address,
        message: messageToSign,
        signature,
        returnTo,
      });
      window.location.assign(authUrl);
    } catch (error) {
      setFieldError((error as Error).message || "Failed to connect Discord.");
      setDiscordActionState("idle");
    }
  }

  async function handleVerifyDiscord() {
    if (!address || !profileSettings || discordActionState !== "idle") {
      return;
    }

    setFieldError(null);
    setStatusMessage(null);
    setDiscordActionState("verifying");

    try {
      const response = await verifyDiscordJoin({ address });
      if (!response.success) {
        throw new Error(response.message || getDiscordVerifyMessage(response.error));
      }

      setStatusMessage("Discord join verified.");
      const refreshed = await fetchProfileSettings(address);
      onSaved(refreshed);
    } catch (error) {
      setFieldError((error as Error).message || "Failed to verify Discord.");
    } finally {
      setDiscordActionState("idle");
    }
  }

  function openDiscordInvite() {
    if (!discordInviteUrl || typeof window === "undefined") {
      return;
    }

    window.open(discordInviteUrl, "_blank", "noopener,noreferrer");
  }

  async function handleDisconnectX() {
    if (!address || !profileSettings || xActionState !== "idle") {
      return;
    }

    setFieldError(null);
    setStatusMessage(null);
    setXActionState("disconnecting");

    try {
      const messageToSign = buildXAccountMessage(address, "disconnect-x");
      const signature = (await signMessageAsync({
        message: messageToSign,
      })) as Hex;
      const response = await disconnectXAccount({
        address,
        message: messageToSign,
        signature,
      });

      if (!response.success) {
        throw new Error(response.error || "Failed to disconnect X.");
      }

      setStatusMessage("X disconnected.");
      onSaved({
        ...(profileSettings as ProfileSettingsResponse),
        profile: {
          ...(profileSettings as ProfileSettingsResponse).profile,
          xConnected: false,
          xConnectedAt: null,
          xUserId: null,
        },
      });
    } catch (error) {
      setFieldError((error as Error).message || "Failed to disconnect X.");
    } finally {
      setXActionState("idle");
    }
  }

  return (
    <div className="fixed left-0 right-0 top-0 z-[80] flex items-end justify-center bg-slate-950/42 px-3 pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur-sm bottom-[calc(var(--ds-mobile-fixed-bottom-offset)+10px)] sm:bottom-0 sm:items-center sm:py-6">
      <button
        type="button"
        aria-label="Close profile settings"
        className="absolute inset-0 cursor-default"
        onClick={() => {
          if (!isSaving) {
            onClose();
          }
        }}
      />

      <section className="relative flex max-h-full min-h-0 w-full max-w-lg flex-col overflow-hidden rounded-t-[26px] border border-white bg-white shadow-[0_24px_80px_rgba(15,23,42,0.22)] sm:max-h-[min(720px,calc(100dvh-3rem))] sm:rounded-[26px]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-4">
          <div>
            <h2 className="text-lg font-black tracking-tight text-slate-950">
              Profile settings
            </h2>
            <p className="mt-1 text-sm leading-5 text-slate-500">
              Update how your profile appears on DustSwap.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Close profile settings"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.2}
                d="M6 6l12 12M18 6 6 18"
              />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          <div className="rounded-2xl border border-sky-100 bg-sky-50/70 p-3">
            <div className="flex items-center gap-3">
              {currentPreviewUrl ? (
                <img
                  src={currentPreviewUrl}
                  alt="Profile preview"
                  className="h-16 w-16 shrink-0 rounded-2xl border border-white object-cover shadow-sm"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-sky-200 bg-white text-sm font-black text-sky-700">
                  0x
                </div>
              )}

              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-slate-700">PFP upload</p>
                <p className="mt-1 text-[11px] leading-4 text-slate-500">
                  PNG, JPG, JPEG, or WEBP under 1 MB.
                </p>
                {!uploadAvailable ? (
                  <div className="mt-1">
                    <p className="text-[11px] font-semibold leading-4 text-amber-700">
                      {uploadUnavailableMessage}
                    </p>
                    {!isProfileSettingsLoading && !profileSettings && onRetryLoad ? (
                      <button
                        type="button"
                        onClick={onRetryLoad}
                        className="mt-1 !min-h-0 !min-w-0 p-0 text-[11px] font-bold text-sky-700 underline-offset-2 hover:underline"
                      >
                        Retry API check
                      </button>
                    ) : null}
                  </div>
                ) : selectedFile ? (
                  <p className="mt-1 truncate text-[11px] font-semibold text-sky-700">
                    {selectedFile.name} ({formatFileSize(selectedFile.size)})
                  </p>
                ) : null}
              </div>
            </div>

            <label
              className={`mt-3 inline-flex w-full items-center justify-center rounded-full border px-3 py-2 text-xs font-bold transition sm:w-auto ${
                uploadAvailable && !isSaving
                  ? "cursor-pointer border-sky-200 bg-white text-sky-700 hover:bg-sky-50"
                  : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
              }`}
            >
              Choose
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={!uploadAvailable || isSaving}
                onChange={(event) =>
                  handleFileSelect(event.currentTarget.files?.[0] || null)
                }
                className="hidden"
              />
            </label>
          </div>

          <div className="mt-4 grid gap-3">
            <label className="grid gap-1.5">
              <span className="text-xs font-bold text-slate-600">
                DustSwap username
              </span>
              <input
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value.toLowerCase().replace(/^@+/, ""));
                  setFieldError(null);
                }}
                placeholder="username.base.eth"
                maxLength={24}
                disabled={isSaving}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-sky-300 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <label className="grid gap-1.5">
              <span className="text-xs font-bold text-slate-600">
                Display name
              </span>
              <input
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  setFieldError(null);
                }}
                placeholder="Nickname"
                maxLength={32}
                disabled={isSaving}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-sky-300 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <div ref={connectionsSectionRef} className="space-y-3">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.24em] text-slate-500">
                  Connected accounts
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  Link the accounts that power your profile and social rewards.
                </p>
              </div>

            <div
              ref={discordCardRef}
              className={`rounded-2xl border bg-white p-3 transition ${
                highlightTarget === "discord_connection"
                  ? "border-sky-300 ring-4 ring-sky-100"
                  : "border-slate-200"
              }`}
            >
              <div className="flex items-center gap-3">
                {discordAccount?.profileImageUrl ? (
                  <img
                    src={discordAccount.profileImageUrl}
                    alt="Connected Discord profile"
                    className="h-11 w-11 shrink-0 rounded-full border border-slate-100 object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-xs font-black text-slate-500">
                    D
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-slate-600">Discord</p>
                  <p className="mt-1 truncate text-sm font-semibold text-slate-950">
                    {discordAccount?.connected
                      ? getDiscordDisplayName(discordAccount)
                      : profile?.discordUsername
                        ? `Legacy saved: ${profile.discordUsername}`
                        : "Not connected"}
                  </p>
                  <p className="mt-0.5 text-[11px] font-medium text-slate-500">
                    {getDiscordStatusLabel(discordAccount)}
                  </p>
                </div>
              </div>

              <div className="mt-3 grid gap-2">
                <button
                  type="button"
                  onClick={() => void handleConnectDiscord()}
                  disabled={isSaving || discordActionState !== "idle" || !address}
                  className="min-h-[40px] w-full rounded-full bg-[#0052ff] px-4 py-2 text-xs font-black text-white transition hover:bg-[#0047db] disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {discordActionState === "connecting"
                    ? "Connecting..."
                    : discordAccount?.connected
                      ? "Reconnect Discord"
                      : "Connect Discord"}
                </button>

                {discordAccount?.connected && discordAccount.joined !== true ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={openDiscordInvite}
                      disabled={isSaving || !discordInviteUrl}
                      className="min-h-[40px] rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Join Discord
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleVerifyDiscord()}
                      disabled={isSaving || discordActionState !== "idle" || !address}
                      className="min-h-[40px] rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {discordActionState === "verifying" ? "Checking..." : "Verify Join"}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <div
              ref={xCardRef}
              className={`rounded-2xl border bg-white p-3 transition ${
                highlightTarget === "x_connection"
                  ? "border-sky-300 ring-4 ring-sky-100"
                  : "border-slate-200"
              }`}
            >
              <div className="flex items-center gap-3">
                {profile?.xAvatar ? (
                  <img
                    src={profile.xAvatar}
                    alt="Connected X profile"
                    className="h-11 w-11 shrink-0 rounded-full border border-slate-100 object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-xs font-black text-slate-500">
                    X
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-slate-600">X account</p>
                  <p className="mt-1 truncate text-sm font-semibold text-slate-950">
                    {profile?.xConnected
                      ? `@${profile.xUsername || "connected"}`
                      : profile?.xUsername
                        ? `Legacy saved: @${profile.xUsername}`
                        : "Not connected"}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleConnectX()}
                  disabled={isSaving || xActionState !== "idle" || !address}
                  className="min-h-[40px] flex-1 rounded-full bg-[#0052ff] px-4 py-2 text-xs font-black text-white transition hover:bg-[#0047db] disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {xActionState === "connecting"
                    ? "Connecting..."
                    : profile?.xConnected
                      ? "Reconnect X"
                      : "Connect X"}
                </button>
                {profile?.xConnected ? (
                  <button
                    type="button"
                    onClick={() => void handleDisconnectX()}
                    disabled={isSaving || xActionState !== "idle" || !address}
                    className="min-h-[40px] flex-1 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {xActionState === "disconnecting" ? "Disconnecting..." : "Disconnect"}
                  </button>
                ) : null}
              </div>
            </div>
            </div>
          </div>

          {fieldError || validationMessage ? (
            <p className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
              {fieldError || validationMessage}
            </p>
          ) : null}

          {statusMessage ? (
            <p className="mt-3 rounded-2xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-medium text-sky-700">
              {statusMessage}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 gap-2 border-t border-slate-200 bg-white px-4 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="min-h-[44px] flex-1 rounded-full border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving || Boolean(validationMessage) || !address}
            className="min-h-[44px] flex-1 rounded-full bg-[#0052ff] px-4 py-2.5 text-sm font-black text-white shadow-[0_12px_26px_rgba(0,82,255,0.22)] transition hover:bg-[#0047db] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
          >
            {isSaving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </section>
    </div>
  );
}

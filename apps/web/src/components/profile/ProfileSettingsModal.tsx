"use client";

import { useEffect, useMemo, useState } from "react";
import { useSignMessage } from "wagmi";
import type { Hex } from "viem";
import {
  buildProfileSettingsMessage,
  normalizeDisplayName,
  normalizeProfileUsername,
  normalizeXUsername,
  requestPfpUploadUrl,
  saveProfileSettings,
  uploadPfpFile,
  validateDiscordUsername,
  validateDisplayName,
  validatePfpFile,
  validateProfileUsername,
  validateXUsername,
  type ProfileSettingsResponse,
} from "@/lib/profileSettings";

type ProfileSettingsModalProps = {
  open: boolean;
  address?: string;
  profileSettings: ProfileSettingsResponse | null;
  onClose: () => void;
  onSaved: (settings: ProfileSettingsResponse) => void;
};

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

export function ProfileSettingsModal({
  open,
  address,
  profileSettings,
  onClose,
  onSaved,
}: ProfileSettingsModalProps) {
  const { signMessageAsync } = useSignMessage();
  const profile = profileSettings?.profile;
  const uploadAvailable =
    profileSettings?.capabilities.pfpUploadAvailable ?? false;
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [discordUsername, setDiscordUsername] = useState("");
  const [xUsername, setXUsername] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

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
    setDiscordUsername(profile?.custom.discordUsername || "");
    setXUsername(profile?.xUsername || "");
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

  const validationMessage = useMemo(() => {
    return (
      validateProfileUsername(username) ||
      validateDisplayName(displayName) ||
      validateDiscordUsername(discordUsername) ||
      validateXUsername(xUsername)
    );
  }, [discordUsername, displayName, username, xUsername]);

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
        discordUsername: normalizeDisplayName(discordUsername),
        pfpUrl,
        pfpStorageKey,
        xUsername: normalizeXUsername(xUsername),
      });

      onSaved(saved);
    } catch (error) {
      setFieldError((error as Error).message || "Failed to save profile.");
    } finally {
      setStatusMessage(null);
      setIsSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/42 px-3 py-3 backdrop-blur-sm sm:items-center">
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

      <section className="relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-t-[26px] border border-white bg-white shadow-[0_24px_80px_rgba(15,23,42,0.22)] sm:rounded-[26px]">
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
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-sm font-black text-slate-500 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Close profile settings"
          >
            x
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="flex items-center gap-3 rounded-2xl border border-sky-100 bg-sky-50/70 p-3">
            {currentPreviewUrl ? (
              <img
                src={currentPreviewUrl}
                alt="Profile preview"
                className="h-16 w-16 rounded-2xl border border-white object-cover shadow-sm"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-sky-200 bg-white text-sm font-black text-sky-700">
                0x
              </div>
            )}

            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-slate-700">PFP upload</p>
              <p className="mt-1 text-[11px] leading-4 text-slate-500">
                PNG, JPG, JPEG, or WEBP under 1 MB.
              </p>
              {!uploadAvailable ? (
                <p className="mt-1 text-[11px] font-semibold text-amber-700">
                  PFP upload is temporarily unavailable.
                </p>
              ) : selectedFile ? (
                <p className="mt-1 truncate text-[11px] font-semibold text-sky-700">
                  {selectedFile.name} ({formatFileSize(selectedFile.size)})
                </p>
              ) : null}
            </div>

            <label
              className={`inline-flex shrink-0 items-center justify-center rounded-full border px-3 py-2 text-xs font-bold transition ${
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
                placeholder="dustswap_user"
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
                placeholder="DustSwap User"
                maxLength={32}
                disabled={isSaving}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-sky-300 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <label className="grid gap-1.5">
              <span className="text-xs font-bold text-slate-600">
                Discord username
              </span>
              <input
                value={discordUsername}
                onChange={(event) => {
                  setDiscordUsername(event.target.value);
                  setFieldError(null);
                }}
                placeholder="name#0000 or name"
                maxLength={40}
                disabled={isSaving}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-sky-300 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <label className="grid gap-1.5">
              <span className="text-xs font-bold text-slate-600">
                X username
              </span>
              <input
                value={xUsername}
                onChange={(event) => {
                  setXUsername(event.target.value.replace(/^@+/, ""));
                  setFieldError(null);
                }}
                placeholder="akbarX402"
                maxLength={15}
                disabled={isSaving}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-sky-300 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
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

        <div className="flex gap-2 border-t border-slate-200 bg-white px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
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

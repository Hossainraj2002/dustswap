"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { buildPublicApiUrl, publicApiFetch } from "@/lib/apiBase";
import { detectBaseAppEnvironment } from "@/lib/baseApp";
import { useWalletWhitelist } from "@/hooks/useWalletWhitelist";

export type PinPromptKind = "pin" | "enable";

export type PinBenefit = {
  icon: "bell" | "sparkle" | "ticket";
  label: string;
  detail: string;
};

type PinStatus = {
  appPinned: boolean;
  notificationsEnabled: boolean;
  prompt: "none" | "pin" | "enable";
  benefits?: PinBenefit[];
};

const STORAGE_KEY = "dustswap.baseapp.pin-prompt.v1";

/**
 * Opting out of notifications in Base App is permanent, and so is the
 * irritation of being asked repeatedly. Three asks, two weeks apart, is the
 * whole budget. After that the prompt never returns on its own.
 */
const REASK_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ASKS = 3;

/** Let the page settle before anything slides up over it. */
const APPEAR_DELAY_MS = 2500;

type DismissalRecord = {
  count: number;
  lastDismissedAt: number;
};

function readDismissal(): DismissalRecord {
  if (typeof window === "undefined") {
    return { count: 0, lastDismissedAt: 0 };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { count: 0, lastDismissedAt: 0 };
    }

    const parsed = JSON.parse(raw) as Partial<DismissalRecord>;
    return {
      count: Number(parsed.count || 0),
      lastDismissedAt: Number(parsed.lastDismissedAt || 0),
    };
  } catch {
    return { count: 0, lastDismissedAt: 0 };
  }
}

function writeDismissal(record: DismissalRecord) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Private mode or blocked storage. Worst case the prompt reappears once.
  }
}

function canAskAgain(record: DismissalRecord) {
  if (record.count === 0) {
    return true;
  }

  if (record.count >= MAX_ASKS) {
    return false;
  }

  return Date.now() - record.lastDismissedAt > REASK_AFTER_MS;
}

/**
 * Decides whether to show the Base App pin prompt, and which of the two asks it
 * should be.
 *
 * Gate order matters. The environment check runs first and locally, so a user
 * outside Base App never triggers a network call, never appears in the API's
 * rate limit, and can never see the prompt.
 */
export function useBaseAppPinPrompt() {
  const { address, isConnected } = useAccount();
  const { isCoinbaseSmartWallet } = useWalletWhitelist();

  const [kind, setKind] = useState<PinPromptKind | null>(null);
  const [benefits, setBenefits] = useState<PinBenefit[]>([]);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isConnected || !address) {
      setKind(null);
      setVisible(false);
      return;
    }

    const { isBaseApp } = detectBaseAppEnvironment(Boolean(isCoinbaseSmartWallet));
    if (!isBaseApp) {
      return;
    }

    if (!canAskAgain(readDismissal())) {
      return;
    }

    let cancelled = false;
    let appearTimer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      try {
        const response = await publicApiFetch(
          buildPublicApiUrl(`/api/notifications/pin-status/${address}`)
        );
        if (!response.ok || cancelled) {
          return;
        }

        const payload = (await response.json()) as {
          success: boolean;
          data?: PinStatus;
        };

        const prompt = payload.data?.prompt;
        if (cancelled || !prompt || prompt === "none") {
          return;
        }

        setBenefits(payload.data?.benefits ?? []);
        setKind(prompt);
        appearTimer = setTimeout(() => {
          if (!cancelled) {
            setVisible(true);
          }
        }, APPEAR_DELAY_MS);
      } catch {
        // Stay quiet. A failed lookup must never produce a prompt.
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (appearTimer) {
        clearTimeout(appearTimer);
      }
    };
  }, [address, isConnected, isCoinbaseSmartWallet]);

  const dismiss = useCallback(() => {
    const record = readDismissal();
    writeDismissal({
      count: record.count + 1,
      lastDismissedAt: Date.now(),
    });
    setVisible(false);
  }, []);

  /** Called when the user says they have turned it on. Stops all future asks. */
  const complete = useCallback(() => {
    writeDismissal({ count: MAX_ASKS, lastDismissedAt: Date.now() });
    setVisible(false);
  }, []);

  return { kind, benefits, visible, dismiss, complete };
}

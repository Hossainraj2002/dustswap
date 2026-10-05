/**
 * Launch settings the owner can change from the admin page. They apply to NEW
 * launches only; each coin snapshots them at launch, so a coin's terms never
 * change under its holders. Bounds mirror the contract's hard caps.
 */
import { BPS, DEFAULT_LAUNCH_SETTINGS, HARD_CAPS } from "./constants";
import type { FeeMode, QuoteKind } from "./types";

export interface LaunchSettings {
  creationFeeEth: number;
  feeMinBps: number;
  feeMaxBps: number;
  defaultFeeBps: number;
  platformShareBps: number;
  referralShareBps: number;
  creatorKeepMaxBps: number;
  snipeStartBps: number;
  snipeDurationSec: number;
  openingFdvUsd: number;
  launchesPaused: boolean;
  enabledModes: FeeMode[];
  /** Which kinds of registered pair assets new coins may use. */
  enabledQuoteKinds: QuoteKind[];
}

export const DEFAULT_SETTINGS: LaunchSettings = {
  ...DEFAULT_LAUNCH_SETTINGS,
  enabledModes: ["creator", "burn", "holders", "floor"],
  enabledQuoteKinds: ["native", "stable", "stock", "token"],
};

export type SettingKey = Exclude<keyof LaunchSettings, "launchesPaused" | "enabledModes" | "enabledQuoteKinds">;

export interface SettingSpec {
  key: SettingKey;
  label: string;
  help: string;
  unit: "bps" | "sec" | "usd" | "eth";
  min: number;
  max: number;
  step: number;
}

export const SETTING_SPECS: SettingSpec[] = [
  { key: "creationFeeEth", label: "Creation fee", help: "Paid by the creator once, at launch.", unit: "eth", min: 0, max: HARD_CAPS.creationFeeMaxEth, step: 0.0005 },
  { key: "feeMinBps", label: "Lowest trading fee", help: "Smallest fee a creator can pick.", unit: "bps", min: 0, max: HARD_CAPS.feeMaxBps, step: 25 },
  { key: "feeMaxBps", label: "Highest trading fee", help: "Largest fee a creator can pick.", unit: "bps", min: 0, max: HARD_CAPS.feeMaxBps, step: 25 },
  { key: "defaultFeeBps", label: "Suggested trading fee", help: "Preselected in the launch form.", unit: "bps", min: 0, max: HARD_CAPS.feeMaxBps, step: 25 },
  { key: "platformShareBps", label: "Platform share of fees", help: "Taken first from every fee.", unit: "bps", min: 0, max: HARD_CAPS.platformShareMaxBps, step: 100 },
  { key: "referralShareBps", label: "Referral share", help: "Part of the platform share paid to the referrer.", unit: "bps", min: 0, max: HARD_CAPS.referralShareMaxBps, step: 100 },
  { key: "creatorKeepMaxBps", label: "Creator keep limit", help: "Most a creator can keep in community modes.", unit: "bps", min: 0, max: HARD_CAPS.creatorKeepMaxBps, step: 500 },
  { key: "snipeStartBps", label: "Launch protection start", help: "Fee at the moment of launch.", unit: "bps", min: 0, max: HARD_CAPS.snipeStartMaxBps, step: 100 },
  { key: "snipeDurationSec", label: "Launch protection length", help: "Seconds until the fee is back to normal.", unit: "sec", min: 0, max: HARD_CAPS.snipeDurationMaxSec, step: 1 },
  { key: "openingFdvUsd", label: "Opening market cap", help: "Every pair opens at this USD value.", unit: "usd", min: HARD_CAPS.openingFdvMinUsd, max: HARD_CAPS.openingFdvMaxUsd, step: 500 },
];

export interface SettingIssue {
  key: keyof LaunchSettings;
  message: string;
}

export function validateSettings(settings: LaunchSettings): SettingIssue[] {
  const issues: SettingIssue[] = [];
  for (const spec of SETTING_SPECS) {
    const value = settings[spec.key];
    if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
      issues.push({ key: spec.key, message: `${spec.label} must be between ${spec.min} and ${spec.max}.` });
    }
    if ((spec.unit === "bps" || spec.unit === "sec") && !Number.isInteger(value)) {
      issues.push({ key: spec.key, message: `${spec.label} must be a whole number.` });
    }
  }
  if (settings.feeMinBps > settings.feeMaxBps) {
    issues.push({ key: "feeMinBps", message: "Lowest fee cannot be above the highest fee." });
  }
  if (settings.defaultFeeBps < settings.feeMinBps || settings.defaultFeeBps > settings.feeMaxBps) {
    issues.push({ key: "defaultFeeBps", message: "Suggested fee must sit between the lowest and highest fee." });
  }
  if (settings.snipeStartBps > 0 && settings.snipeStartBps < settings.feeMaxBps) {
    issues.push({ key: "snipeStartBps", message: "Launch protection must start at or above the highest trading fee, or be 0." });
  }
  if (settings.enabledModes.length === 0) {
    issues.push({ key: "enabledModes", message: "Keep at least one fee destination enabled." });
  }
  if (settings.enabledQuoteKinds.length === 0) {
    issues.push({ key: "enabledQuoteKinds", message: "Keep at least one kind of pair enabled." });
  }
  if (settings.platformShareBps > BPS) {
    issues.push({ key: "platformShareBps", message: "Platform share cannot exceed 100%." });
  }
  return issues;
}

/** Which settings differ, for the admin "review changes" step. */
export function diffSettings(current: LaunchSettings, next: LaunchSettings) {
  return (Object.keys(next) as Array<keyof LaunchSettings>).filter((key) => {
    const a = current[key];
    const b = next[key];
    return Array.isArray(a) && Array.isArray(b) ? a.slice().sort().join() !== b.slice().sort().join() : a !== b;
  });
}

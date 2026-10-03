"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "@/components/theme/ThemeProvider";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useHydrated } from "@/lib/hooks";

const OPTIONS = [
  { value: "system", label: "Auto", spoken: "Match device", icon: Monitor },
  { value: "light", label: "Light", spoken: "Light", icon: Sun },
  { value: "dark", label: "Dark", spoken: "Dark", icon: Moon },
] as const;

/** Appearance picker. `iconOnly` fits narrow places like the sidebar. */
export function ThemeSegmented({ size = "md", iconOnly = false }: { size?: "md" | "sm"; iconOnly?: boolean }) {
  const { preference, setPreference } = useTheme();
  const hydrated = useHydrated();
  return (
    <SegmentedControl<ThemePreference>
      label="Appearance"
      fullWidth
      size={size}
      value={hydrated ? preference : "system"}
      onChange={setPreference}
      segments={OPTIONS.map(({ value, label, spoken, icon: Icon }) => ({
        value,
        ariaLabel: spoken,
        label: (
          <span className="inline-flex items-center gap-1.5">
            <Icon className="size-4" aria-hidden />
            {iconOnly ? null : label}
          </span>
        ),
      }))}
    />
  );
}

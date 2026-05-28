"use client";

import { useTheme, type ThemePreference } from "@/components/theme/ThemeProvider";

const THEME_OPTIONS: Array<{
  label: string;
  value: ThemePreference;
  description: string;
}> = [
  {
    label: "System",
    value: "system",
    description: "Follow your device",
  },
  {
    label: "Light",
    value: "light",
    description: "Bright glass UI",
  },
  {
    label: "Dark",
    value: "dark",
    description: "Deep navy UI",
  },
];

type ThemePreferenceControlProps = {
  variant?: "card" | "compact";
  className?: string;
};

export function ThemePreferenceControl({
  variant = "card",
  className = "",
}: ThemePreferenceControlProps) {
  const { preference, resolvedTheme, setPreference } = useTheme();
  const compact = variant === "compact";

  return (
    <section
      className={`${compact
        ? "max-h-[4cm] rounded-[20px] border border-white/70 bg-white/82 px-3 py-2.5 shadow-[0_14px_34px_rgba(15,23,42,0.08)] backdrop-blur dark:border-white/10 dark:bg-[rgba(11,18,32,0.78)] dark:shadow-[0_18px_42px_rgba(0,0,0,0.28)]"
        : "rounded-[28px] border border-white/70 bg-white/82 px-4 py-4 shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur dark:border-white/10 dark:bg-[rgba(11,18,32,0.82)] dark:shadow-[0_24px_80px_rgba(0,0,0,0.34)] sm:px-5"
      } ${className}`}
    >
      <div className={compact ? "flex items-center justify-between gap-3" : "flex flex-col gap-1"}>
        <div>
          <p className={`${compact ? "text-[8px]" : "text-[9px]"} font-black uppercase tracking-[0.32em] text-slate-500 dark:text-slate-400`}>
            Appearance
          </p>
          <h2 className={`${compact ? "mt-0.5 text-sm" : "text-base"} font-black tracking-tight text-slate-950 dark:text-white`}>
            {compact ? "Theme" : "Personalize your interface"}
          </h2>
        </div>
        <p className={`${compact ? "shrink-0 text-[11px] leading-4" : "text-sm leading-6"} text-slate-600 dark:text-slate-300`}>
          Current: {resolvedTheme === "dark" ? "Dark" : "Light"}
        </p>
      </div>

      <div className={compact ? "mt-2 grid grid-cols-3 gap-1.5" : "mt-3 grid gap-2 sm:grid-cols-3"}>
        {THEME_OPTIONS.map((option) => {
          const active = option.value === preference;

          return (
            <button
              key={option.value}
              type="button"
              onClick={() => setPreference(option.value)}
              className={`${compact ? "rounded-[14px] px-2 py-2 text-center" : "rounded-[20px] px-3 py-3 text-left"} border transition-all duration-200 ${
                active
                  ? "border-sky-300 bg-sky-50 text-slate-950 shadow-[0_14px_32px_rgba(14,165,233,0.14)] dark:border-sky-400/70 dark:bg-sky-400/12 dark:text-white dark:shadow-[0_18px_40px_rgba(14,165,233,0.18)]"
                  : "border-slate-200 bg-white/75 text-slate-600 hover:border-sky-200 hover:bg-sky-50/70 hover:text-slate-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:border-sky-400/40 dark:hover:bg-sky-400/10 dark:hover:text-white"
              }`}
              aria-pressed={active}
            >
              <span className={`${compact ? "text-xs" : "text-sm"} block font-black`}>
                {option.label}
              </span>
              {compact ? null : (
                <span className="mt-1 block text-[11px] font-semibold leading-4 opacity-75">
                  {option.description}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

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

export function ThemePreferenceControl() {
  const { preference, resolvedTheme, setPreference } = useTheme();

  return (
    <section className="rounded-[28px] border border-white/70 bg-white/82 px-4 py-4 shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur dark:border-white/10 dark:bg-[rgba(11,18,32,0.82)] dark:shadow-[0_24px_80px_rgba(0,0,0,0.34)] sm:px-5">
      <div className="flex flex-col gap-1">
        <p className="text-[9px] font-black uppercase tracking-[0.32em] text-slate-500 dark:text-slate-400">
          Appearance
        </p>
        <h2 className="text-base font-black tracking-tight text-slate-950 dark:text-white">
          Personalize your interface
        </h2>
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">
          Current theme: {resolvedTheme === "dark" ? "Dark" : "Light"}.
        </p>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {THEME_OPTIONS.map((option) => {
          const active = option.value === preference;

          return (
            <button
              key={option.value}
              type="button"
              onClick={() => setPreference(option.value)}
              className={`rounded-[20px] border px-3 py-3 text-left transition-all duration-200 ${
                active
                  ? "border-sky-300 bg-sky-50 text-slate-950 shadow-[0_14px_32px_rgba(14,165,233,0.14)] dark:border-sky-400/70 dark:bg-sky-400/12 dark:text-white dark:shadow-[0_18px_40px_rgba(14,165,233,0.18)]"
                  : "border-slate-200 bg-white/75 text-slate-600 hover:border-sky-200 hover:bg-sky-50/70 hover:text-slate-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:border-sky-400/40 dark:hover:bg-sky-400/10 dark:hover:text-white"
              }`}
              aria-pressed={active}
            >
              <span className="block text-sm font-black">{option.label}</span>
              <span className="mt-1 block text-[11px] font-semibold leading-4 opacity-75">
                {option.description}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

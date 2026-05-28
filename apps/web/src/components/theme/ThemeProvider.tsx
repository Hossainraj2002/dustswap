"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "dustswap-theme";

type ThemeContextValue = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function getSystemTheme(): ResolvedTheme {
  if (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }

  return "light";
}

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }

  try {
    const storedPreference = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(storedPreference) ? storedPreference : "system";
  } catch {
    return "system";
  }
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? getSystemTheme() : preference;
}

function applyTheme(resolvedTheme: ResolvedTheme, preference: ThemePreference) {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  root.classList.toggle("dark", resolvedTheme === "dark");
  root.dataset.theme = resolvedTheme;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolvedTheme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");

  useEffect(() => {
    const initialPreference = readStoredPreference();
    const initialResolvedTheme = resolveTheme(initialPreference);
    setPreferenceState(initialPreference);
    setResolvedTheme(initialResolvedTheme);
    applyTheme(initialResolvedTheme, initialPreference);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    function syncSystemTheme() {
      setResolvedTheme((currentResolvedTheme) => {
        const nextResolvedTheme = resolveTheme(preference);
        if (nextResolvedTheme !== currentResolvedTheme) {
          applyTheme(nextResolvedTheme, preference);
        }
        return nextResolvedTheme;
      });
    }

    syncSystemTheme();
    mediaQuery.addEventListener("change", syncSystemTheme);

    return () => {
      mediaQuery.removeEventListener("change", syncSystemTheme);
    };
  }, [preference]);

  const setPreference = useCallback((nextPreference: ThemePreference) => {
    setPreferenceState(nextPreference);

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextPreference);
    } catch {
      // Theme switching should keep working even when storage is unavailable.
    }

    const nextResolvedTheme = resolveTheme(nextPreference);
    setResolvedTheme(nextResolvedTheme);
    applyTheme(nextResolvedTheme, nextPreference);
  }, []);

  const value = useMemo(
    () => ({
      preference,
      resolvedTheme,
      setPreference,
    }),
    [preference, resolvedTheme, setPreference]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }

  return context;
}

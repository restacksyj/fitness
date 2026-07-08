"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type Theme = "dark" | "light";

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: "dark" | "light";
  cycleTheme: () => void;
};

const THEME_STORAGE_KEY = "progressfit-theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);
const THEME_COLORS = { light: "#ffffff", dark: "#111111" };
const IOS_STATUS_BAR_STYLE = { light: "default", dark: "black" };

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  return saved === "dark" || saved === "light" ? saved : "light";
}

function resolveTheme(theme: Theme) {
  return theme;
}

function setMetaContent(selector: string, name: string, content: string) {
  let meta = document.head.querySelector<HTMLMetaElement>(selector);
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", name);
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", content);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");
  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">("light");

  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  useEffect(() => {
    const updateDocumentTheme = () => {
      const resolved = resolveTheme(theme);
      setResolvedTheme(resolved);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      setMetaContent("meta[name='theme-color']:not([media])", "theme-color", THEME_COLORS[resolved]);
      setMetaContent("meta[name='apple-mobile-web-app-status-bar-style']", "apple-mobile-web-app-status-bar-style", IOS_STATUS_BAR_STYLE[resolved]);
    };

    localStorage.setItem(THEME_STORAGE_KEY, theme);
    updateDocumentTheme();
  }, [theme]);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    resolvedTheme,
    cycleTheme: () => setTheme((current) => current === "dark" ? "light" : "dark"),
  }), [resolvedTheme, theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}

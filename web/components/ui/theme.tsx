"use client";
/**
 * Theme: system (default), light or dark. The choice lives in localStorage and is applied by
 * an inline script in <head> before first paint, so a reload never flashes the wrong theme.
 */
import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { THEME_KEY } from "./theme-script";

export { THEME_KEY, themeScript } from "./theme-script";
type Theme = "system" | "light" | "dark";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const ICON = { system: Monitor, light: Sun, dark: Moon } as const;

function apply(theme: Theme) {
  const root = document.documentElement;
  try {
    if (theme === "system") {
      delete root.dataset.theme;
      localStorage.removeItem(THEME_KEY);
    } else {
      root.dataset.theme = theme;
      localStorage.setItem(THEME_KEY, theme);
    }
  } catch {
    // storage blocked (private mode): the theme still applies for this page
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }
}

// The source of truth is <html data-theme>, set before paint; React just subscribes to it.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
const current = (): Theme => {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
};

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, current, () => "system" as Theme);
  const Icon = ICON[theme];
  return (
    <button
      type="button"
      onClick={() => apply(NEXT[theme])}
      aria-label={`Theme: ${theme}. Switch to ${NEXT[theme]}.`}
      title={`Theme: ${theme}`}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--line)] text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
    >
      <Icon aria-hidden="true" width={16} height={16} />
    </button>
  );
}

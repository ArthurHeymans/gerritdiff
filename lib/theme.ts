"use client";

import { useSyncExternalStore } from "react";

export type GerritDiffTheme = "dark" | "light";

const THEME_EVENT = "gerritdiff-theme-change";
const THEME_STORAGE_KEY = "gerritdiff-theme";

function storedTheme(): GerritDiffTheme | undefined {
  try {
    const theme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return theme === "dark" || theme === "light" ? theme : undefined;
  } catch {
    return undefined;
  }
}

function subscribe(listener: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key && event.key !== THEME_STORAGE_KEY) return;
    const theme = storedTheme();
    if (theme) document.documentElement.dataset.theme = theme;
    listener();
  };
  window.addEventListener(THEME_EVENT, listener);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(THEME_EVENT, listener);
    window.removeEventListener("storage", handleStorage);
  };
}

function getSnapshot(): GerritDiffTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function useGerritDiffTheme(): GerritDiffTheme {
  return useSyncExternalStore(subscribe, getSnapshot, () => "light");
}

export function setGerritDiffTheme(theme: GerritDiffTheme) {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The current page can still use the selected theme without persistence.
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}

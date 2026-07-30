"use client";

import { useSyncExternalStore } from "react";

export type GerritDiffTheme = "dark" | "light";

const THEME_EVENT = "gerritdiff-theme-change";

function subscribe(listener: () => void) {
  window.addEventListener(THEME_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(THEME_EVENT, listener);
    window.removeEventListener("storage", listener);
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
  localStorage.setItem("gerritdiff-theme", theme);
  window.dispatchEvent(new Event(THEME_EVENT));
}

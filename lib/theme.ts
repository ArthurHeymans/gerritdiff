"use client";

import { useSyncExternalStore } from "react";

export type ClankerTheme = "dark" | "light";

const THEME_EVENT = "clanker-theme-change";

function subscribe(listener: () => void) {
  window.addEventListener(THEME_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(THEME_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

function getSnapshot(): ClankerTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function useClankerTheme(): ClankerTheme {
  return useSyncExternalStore(subscribe, getSnapshot, () => "dark");
}

export function setClankerTheme(theme: ClankerTheme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("clanker-theme", theme);
  window.dispatchEvent(new Event(THEME_EVENT));
}

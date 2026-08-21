"use client";

import { useRef, useState } from "react";
import { ArrowRight, Moon, Search, Sun, X } from "lucide-react";
import { setGerritDiffTheme, useGerritDiffTheme } from "@/lib/theme";

export function Logo() {
  return (
    <span className="brand">
      <svg className="logo-mark" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="0" y="2" width="7" height="2.5" rx="1" className="lm-del" />
        <rect x="0" y="6.75" width="7" height="2.5" rx="1" opacity=".35" />
        <rect x="0" y="11.5" width="7" height="2.5" rx="1" opacity=".35" />
        <rect x="9" y="2" width="7" height="2.5" rx="1" opacity=".35" />
        <rect x="9" y="6.75" width="7" height="2.5" rx="1" className="lm-add" />
        <rect x="9" y="11.5" width="7" height="2.5" rx="1" opacity=".35" />
      </svg>
      <span>gerrit<b>diff</b></span>
    </span>
  );
}

export function HomeLink() {
  return <button type="button" className="logo-link home-button" aria-label="GerritDiff home" onClick={() => window.location.assign(
    "/",
  )}><Logo /></button>;
}

export function ThemeButton() {
  const theme = useGerritDiffTheme();
  return (
    <button className="icon-button" onClick={() => setGerritDiffTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle color theme">
      {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}

export function UrlForm({ initial = "", compact = false }: { initial?: string; compact?: boolean }) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);

  function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    const url = value.trim();
    if (!url) return input.current?.focus();
    window.location.assign(`/?url=${encodeURIComponent(url)}`);
  }

  function clear() {
    setValue("");
    input.current?.focus();
  }

  return (
    <form className={compact ? "url-form compact" : "url-form"} onSubmit={submit}>
      <div className="url-icon"><Search size={18} /></div>
      <input
        ref={input}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Paste a Gerrit change URL…"
        aria-label="Gerrit change URL"
        spellCheck={false}
      />
      {value && (
        <button type="button" className="url-clear" aria-label="Clear URL" onClick={clear}>
          <X size={15} />
        </button>
      )}
      <button type="submit" className="url-submit" aria-label="Open change" data-empty={!value.trim() || undefined}>
        <ArrowRight size={16} />
      </button>
    </form>
  );
}

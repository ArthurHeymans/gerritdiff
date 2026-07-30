"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, ExternalLink, LoaderCircle, Moon, Search, Sun, X } from "lucide-react";
import { ChangeReview } from "@/components/change-review";
import { setGerritDiffTheme, useGerritDiffTheme } from "@/lib/theme";
import type { ChangeData } from "@/lib/types";

const EXAMPLES = [
  {
    label: "Gerrit Code Review",
    url: "https://gerrit-review.googlesource.com/c/gerrit/+/611561",
  },
  {
    label: "Chromium",
    url: "https://chromium-review.googlesource.com/c/chromium/src/+/8164642",
  },
];

function Logo() {
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

function HomeLink() {
  return <button type="button" className="logo-link home-button" aria-label="GerritDiff home" onClick={() => window.location.assign("/")}><Logo /></button>;
}

function ThemeButton() {
  const theme = useGerritDiffTheme();
  return (
    <button className="icon-button" onClick={() => setGerritDiffTheme(theme === "dark" ? "light" : "dark")}  aria-label="Toggle color theme">
      {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}

function UrlForm({ initial = "", compact = false }: { initial?: string; compact?: boolean }) {
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

function Landing() {
  return (
    <main className="landing">
      <nav className="nav shell">
        <Logo />
        <div className="nav-actions"><ThemeButton /></div>
      </nav>

      <section className="hero shell">
        <h1>Read Gerrit changes, faster.</h1>
        <p className="hero-copy">Paste a public Gerrit change URL for a side-by-side diff, file tree, and inline discussions.</p>
        <UrlForm />

        <div className="examples">
          <span>Try</span>
          {EXAMPLES.map((example) => (
            <button key={example.url} onClick={() => window.location.assign(`/?url=${encodeURIComponent(example.url)}`)}>
              {example.label}
            </button>
          ))}
        </div>
      </section>

      <footer className="footer shell">
        <span>No sign-in · public changes only · not affiliated with Gerrit</span>
        <a href="https://www.gerritcodereview.com/">gerritcodereview.com</a>
      </footer>
    </main>
  );
}

function patchsetUrl(sourceUrl: string, changeNumber: number, patchset: number) {
  const url = new URL(sourceUrl);
  const modern = new RegExp(`(/\\+/${changeNumber})(?:/\\d+)?(?:/.*)?$`);
  if (modern.test(url.pathname)) url.pathname = url.pathname.replace(modern, `$1/${patchset}`);
  else {
    const legacy = new RegExp(`(/c/${changeNumber})(?:/\\d+)?(?:/.*)?$`);
    url.hash = url.hash.replace(legacy, `$1/${patchset}`);
  }
  return url.toString();
}

function Viewer({ data, initialThreadId }: { data: ChangeData; initialThreadId?: string }) {
  const theme = useGerritDiffTheme();
  const openComparison = (patchset: number, base?: number, threadId?: string) => {
    const url = patchsetUrl(data.sourceUrl, data.changeNumber, patchset);
    const query = new URLSearchParams({ url });
    if (base !== undefined) query.set("base", String(base));
    if (threadId) query.set("thread", threadId);
    window.location.assign(`/?${query}`);
  };
  const openPatchset = (patchset: number, threadId?: string) => openComparison(patchset, data.baseRevisionNumber === patchset ? undefined : data.baseRevisionNumber, threadId);
  return (
    <main className="viewer">
      <header className="viewer-topbar">
        <HomeLink />
        <UrlForm initial={data.sourceUrl} compact />
        <div className="topbar-actions">
          <a className="source-link" href={data.sourceUrl} target="_blank" rel="noreferrer">Gerrit <ExternalLink size={14} /></a>
          <ThemeButton />
        </div>
      </header>
      <ChangeReview data={data} theme={theme} initialThreadId={initialThreadId} onPatchsetChange={openPatchset} onBaseChange={(base) => openComparison(data.revisionNumber, base)} />
    </main>
  );
}

function ChangeLoader({ url, base, threadId }: { url: string; base?: string; threadId?: string }) {
  const [data, setData] = useState<ChangeData | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/change?url=${encodeURIComponent(url)}${base ? `&base=${encodeURIComponent(base)}` : ""}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Couldn't load this change.");
        return body as ChangeData;
      })
      .then(setData)
      .catch((reason) => {
        if (reason.name !== "AbortError") setError(reason.message);
      });
    return () => controller.abort();
  }, [attempt, base, url]);

  if (error) return (
    <main className="state-page">
      <nav className="nav shell"><HomeLink /><ThemeButton /></nav>
      <div className="state-card error-card">
        <span>!</span>
        <h1>Couldn&apos;t load this change</h1>
        <p className="state-guidance">Check the Gerrit URL, try again, or paste a different change below.</p>
        <UrlForm initial={url} />
        <div className="state-actions">
          <button type="button" onClick={() => { setError(""); setAttempt((current) => current + 1); }}>Try again</button>
          <button type="button" className="secondary" onClick={() => window.location.assign("/")}>Start over</button>
        </div>
        <details className="error-details">
          <summary>Technical details</summary>
          <p>{error}</p>
        </details>
      </div>
    </main>
  );
  if (!data) return (
    <main className="state-page">
      <nav className="nav shell"><HomeLink /><ThemeButton /></nav>
      <div className="state-card"><LoaderCircle className="spinner" size={30} /><h1>Loading change</h1><p>Fetching metadata and patch from Gerrit…</p></div>
    </main>
  );
  return <Viewer data={data} initialThreadId={threadId} />;
}

export function GerritDiffApp() {
  const searchParams = useSearchParams();
  const url = searchParams.get("url");
  const base = searchParams.get("base") ?? undefined;
  const threadId = searchParams.get("thread") ?? undefined;
  return url ? <ChangeLoader key={`${url}:${base ?? "parent"}:${threadId ?? "no-thread"}`} url={url} base={base} threadId={threadId} /> : <Landing />;
}

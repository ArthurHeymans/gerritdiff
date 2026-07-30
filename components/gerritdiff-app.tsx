"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  Check,
  Code2,
  ExternalLink,
  FileCode2,
  GitBranch,
  LoaderCircle,
  Moon,
  Search,
  Sun,
  Zap,
} from "lucide-react";
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
    <div className="brand">
      <span className="logo-mark"><span /></span>
      <span>gerritdiff</span>
      <span className="beta">beta</span>
    </div>
  );
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
  const router = useRouter();
  const [value, setValue] = useState(initial);

  function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    const url = value.trim();
    if (url) router.push(`/?url=${encodeURIComponent(url)}`);
  }

  return (
    <form className={compact ? "url-form compact" : "url-form"} onSubmit={submit}>
      <div className="url-icon"><Search size={18} /></div>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Paste a Gerrit change URL…"
        aria-label="Gerrit change URL"
        spellCheck={false}
      />
      <button type="submit" aria-label="Open change">
        <span>{compact ? "Open" : "View change"}</span><ArrowRight size={17} />
      </button>
    </form>
  );
}

function Landing() {
  const router = useRouter();
  return (
    <main className="landing">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <nav className="nav shell">
        <Logo />
        <div className="nav-actions">
          <a href="https://www.gerritcodereview.com/" aria-label="Gerrit Code Review"><Code2 size={18} /></a>
          <ThemeButton />
        </div>
      </nav>

      <section className="hero shell">
        <div className="eyebrow"><Zap size={14} fill="currentColor" /> Built for Gerrit power users</div>
        <h1>The Gerrit diff viewer<br /><em>you&apos;ll actually enjoy.</em></h1>
        <p className="hero-copy">Fast, focused, and made for reviewing code. Paste any public Gerrit change and get a clean, distraction-free diff.</p>
        <UrlForm />
        <p className="privacy"><Check size={13} /> No sign-in. No tracking. Public changes only.</p>

        <div className="examples">
          <span>Or try an example</span>
          {EXAMPLES.map((example) => (
            <button key={example.url} onClick={() => router.push(`/?url=${encodeURIComponent(example.url)}`)}>
              <FileCode2 size={14} /> {example.label} <ArrowRight size={13} />
            </button>
          ))}
        </div>
      </section>

      <section className="feature-strip shell">
        <div><span className="feature-icon violet"><Zap size={18} /></span><p><strong>Instant</strong><small>Streams straight from Gerrit</small></p></div>
        <div><span className="feature-icon green"><Code2 size={18} /></span><p><strong>Focused</strong><small>Code first, clutter nowhere</small></p></div>
        <div><span className="feature-icon blue"><GitBranch size={18} /></span><p><strong>Universal</strong><small>Works with any public Gerrit</small></p></div>
      </section>

      <footer className="footer shell">
        <span>Built for people who review code.</span>
        <span>GerritDiff is not affiliated with Gerrit.</span>
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

function Viewer({ data }: { data: ChangeData }) {
  const theme = useGerritDiffTheme();
  const openComparison = (patchset: number, base?: number) => {
    const url = patchsetUrl(data.sourceUrl, data.changeNumber, patchset);
    const baseQuery = base === undefined ? "" : `&base=${base}`;
    window.location.assign(`/?url=${encodeURIComponent(url)}${baseQuery}`);
  };
  const openPatchset = (patchset: number) => openComparison(patchset, data.baseRevisionNumber === patchset ? undefined : data.baseRevisionNumber);
  return (
    <main className="viewer">
      <header className="viewer-topbar">
        <Link href="/" className="logo-link"><Logo /></Link>
        <UrlForm initial={data.sourceUrl} compact />
        <div className="topbar-actions">
          <a className="source-link" href={data.sourceUrl} target="_blank" rel="noreferrer">Gerrit <ExternalLink size={14} /></a>
          <ThemeButton />
        </div>
      </header>
      <ChangeReview data={data} theme={theme} onPatchsetChange={openPatchset} onBaseChange={(base) => openComparison(data.revisionNumber, base)} />
    </main>
  );
}

function ChangeLoader({ url, base }: { url: string; base?: string }) {
  const [data, setData] = useState<ChangeData | null>(null);
  const [error, setError] = useState("");

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
  }, [base, url]);

  if (error) return (
    <main className="state-page">
      <nav className="nav shell"><Link href="/" className="logo-link"><Logo /></Link><ThemeButton /></nav>
      <div className="state-card error-card"><span>!</span><h1>Couldn&apos;t load change</h1><p>{error}</p><Link href="/">Try another URL</Link></div>
    </main>
  );
  if (!data) return (
    <main className="state-page">
      <nav className="nav shell"><Logo /><ThemeButton /></nav>
      <div className="state-card"><LoaderCircle className="spinner" size={30} /><h1>Loading change</h1><p>Fetching metadata and patch from Gerrit…</p></div>
    </main>
  );
  return <Viewer data={data} />;
}

export function GerritDiffApp() {
  const searchParams = useSearchParams();
  const url = searchParams.get("url");
  const base = searchParams.get("base") ?? undefined;
  return url ? <ChangeLoader key={`${url}:${base ?? "parent"}`} url={url} base={base} /> : <Landing />;
}

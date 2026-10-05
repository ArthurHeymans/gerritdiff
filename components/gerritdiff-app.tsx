"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ExternalLink, LayoutDashboard, LoaderCircle } from "lucide-react";
import { HomeLink, Logo, ThemeButton, UrlForm } from "@/components/app-chrome";
import { ChangeReview } from "@/components/change-review";
import { Dashboard, DashboardProfileForm } from "@/components/dashboard";
import { normalizeGerritServer, patchsetUrl } from "@/lib/gerrit-url";
import { useGerritDiffTheme } from "@/lib/theme";
import type { ChangeData, DashboardProfile } from "@/lib/types";

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

const DASHBOARD_PROFILE_KEY = "gerritdiff:dashboard-profile";
const DASHBOARD_PROFILE_EVENT = "gerritdiff:dashboard-profile-change";

function subscribeDashboardProfile(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(DASHBOARD_PROFILE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(DASHBOARD_PROFILE_EVENT, listener);
  };
}

function dashboardProfileSnapshot() {
  return window.localStorage.getItem(DASHBOARD_PROFILE_KEY) ?? "";
}

function saveDashboardProfile(profile: DashboardProfile | null) {
  if (profile) window.localStorage.setItem(DASHBOARD_PROFILE_KEY, JSON.stringify(profile));
  else window.localStorage.removeItem(DASHBOARD_PROFILE_KEY);
  window.dispatchEvent(new Event(DASHBOARD_PROFILE_EVENT));
}

function parseDashboardProfile(value: string): DashboardProfile | null {
  try {
    const profile = JSON.parse(value) as Partial<DashboardProfile>;
    return profile.server && profile.username
      ? { server: normalizeGerritServer(profile.server).toString(), username: profile.username, accountId: profile.accountId }
      : null;
  } catch {
    return null;
  }
}

function Landing({ onSaveProfile }: { onSaveProfile(profile: DashboardProfile): void }) {
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

        <DashboardProfileForm onSave={onSaveProfile} />
      </section>

      <footer className="footer shell">
        <span>No sign-in · public changes only · not affiliated with Gerrit</span>
        <a href="https://www.gerritcodereview.com/">gerritcodereview.com</a>
      </footer>
    </main>
  );
}

function Viewer({ data, initialThreadId, loading, returnTo }: { data: ChangeData; initialThreadId?: string; loading: boolean; returnTo?: string }) {
  const theme = useGerritDiffTheme();
  const router = useRouter();
  const openComparison = (patchset: number, base?: number, threadId?: string) => {
    const url = patchsetUrl(data.sourceUrl, data.changeNumber, patchset);
    const query = new URLSearchParams({ url });
    if (base !== undefined) query.set("base", String(base));
    if (threadId) query.set("thread", threadId);
    if (returnTo) query.set("return", returnTo);
    router.push(`/?${query}`, { scroll: false });
  };
  const openPatchset = (patchset: number, threadId?: string) => openComparison(patchset, data.baseRevisionNumber === patchset ? undefined : data.baseRevisionNumber, threadId);
  return (
    <main className="viewer">
      <header className="viewer-topbar">
        <HomeLink />
        <UrlForm initial={data.sourceUrl} compact />
        <div className="topbar-actions">
          {returnTo && <a className="source-link dashboard-return" href={returnTo} onClick={(event) => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            router.push(returnTo);
          }}><LayoutDashboard size={14} /> Dashboard</a>}
          <a className="source-link" href={data.sourceUrl} target="_blank" rel="noreferrer">Gerrit <ExternalLink size={14} /></a>
          <ThemeButton />
        </div>
      </header>
      <ChangeReview key={`${data.revision}:${data.baseRevisionNumber ?? "parent"}`} data={data} theme={theme} initialThreadId={initialThreadId} dashboardReturnTo={returnTo} comparisonLoading={loading} onPatchsetChange={openPatchset} onBaseChange={(base, threadId) => openComparison(data.revisionNumber, base, threadId)} />
    </main>
  );
}

function ChangeLoader({ url, base, threadId, returnTo }: { url: string; base?: string; threadId?: string; returnTo?: string }) {
  const [data, setData] = useState<ChangeData | null>(null);
  const [error, setError] = useState<{ request: string; message: string } | null>(null);
  const [loadedRequest, setLoadedRequest] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestKey = JSON.stringify([url, base ?? null]);
  const loading = loadedRequest !== requestKey;

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/change?url=${encodeURIComponent(url)}${base ? `&base=${encodeURIComponent(base)}` : ""}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Couldn't load this change.");
        return body as ChangeData;
      })
      .then((nextData) => {
        if (controller.signal.aborted) return;
        setData(nextData);
        setLoadedRequest(requestKey);
        setError(null);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError({ request: requestKey, message: reason.message });
      });
    return () => controller.abort();
  }, [attempt, base, requestKey, url]);

  if (error?.request === requestKey) return (
    <main className="state-page">
      <nav className="nav shell"><HomeLink /><ThemeButton /></nav>
      <div className="state-card error-card">
        <span>!</span>
        <h1>Couldn&apos;t load this change</h1>
        <p className="state-guidance">Check the Gerrit URL, try again, or paste a different change below.</p>
        <UrlForm initial={url} />
        <div className="state-actions">
          <button type="button" onClick={() => { setError(null); setAttempt((current) => current + 1); }}>Try again</button>
          <button type="button" className="secondary" onClick={() => window.location.assign("/")}>Start over</button>
        </div>
        <details className="error-details">
          <summary>Technical details</summary>
          <p>{error.message}</p>
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
  return <Viewer data={data} initialThreadId={threadId} loading={loading} returnTo={returnTo} />;
}

export function GerritDiffApp() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const profileValue = useSyncExternalStore(subscribeDashboardProfile, dashboardProfileSnapshot, () => "");
  const localProfile = parseDashboardProfile(profileValue);
  const sharedServer = searchParams.get("server");
  const sharedUser = searchParams.get("user");
  const sharedAccount = searchParams.get("account");
  let profile = localProfile;
  let sharedIdentity = false;
  if (pathname === "/dashboard" && sharedServer && (sharedUser || sharedAccount)) {
    try {
      profile = {
        server: normalizeGerritServer(sharedServer).toString(),
        username: sharedUser ?? sharedAccount ?? "",
        accountId: sharedAccount && /^\d+$/.test(sharedAccount) ? Number(sharedAccount) : undefined,
      };
      sharedIdentity = !localProfile
        || localProfile.server !== profile.server
        || localProfile.username !== profile.username;
    } catch {
      profile = null;
    }
  }
  const url = searchParams.get("url");
  const base = searchParams.get("base") ?? undefined;
  const threadId = searchParams.get("thread") ?? undefined;
  const requestedReturn = searchParams.get("return");
  const returnTo = requestedReturn?.startsWith("/dashboard") ? requestedReturn : undefined;
  const saveAndOpenDashboard = (nextProfile: DashboardProfile) => {
    saveDashboardProfile(nextProfile);
    const preservedView = pathname === "/dashboard" ? searchParams.toString() : "";
    router.push(preservedView ? `/dashboard?${preservedView}` : "/dashboard");
  };
  if (url) return <ChangeLoader url={url} base={base} threadId={threadId} returnTo={returnTo} />;
  if (searchParams.get("setup") === "1") return <Landing onSaveProfile={saveAndOpenDashboard} />;
  if (profile) return <Dashboard key={`${profile.server}:${profile.username}`} profile={profile} sharedIdentity={sharedIdentity} onForget={sharedIdentity ? () => router.push("/?setup=1") : () => saveDashboardProfile(null)} />;
  return <Landing onSaveProfile={saveAndOpenDashboard} />;
}

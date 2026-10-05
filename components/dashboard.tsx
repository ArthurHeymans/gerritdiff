"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, LoaderCircle, RefreshCw, Search, Settings2, Share2 } from "lucide-react";
import { Logo, ThemeButton, UrlForm } from "@/components/app-chrome";
import { normalizeGerritServer } from "@/lib/gerrit-url";
import type { DashboardChange, DashboardData, DashboardGroup, DashboardOwnership, DashboardProfile, DashboardScope } from "@/lib/types";

type DashboardViewState = {
  scope: "all" | DashboardScope;
  workState: "all" | DashboardGroup;
  wipFilter: "all" | "wip" | "reviewable";
  project: string;
  owners: string[];
  topic: string;
  sort: "priority" | "freshest" | "oldest";
  activityAgeFilter: number;
  scrollY: number;
};

const DEFAULT_VIEW_STATE: DashboardViewState = {
  scope: "all",
  workState: "all",
  wipFilter: "all",
  project: "all",
  owners: [],
  topic: "all",
  sort: "priority",
  activityAgeFilter: 0,
  scrollY: 0,
};

function parseActivityAge(value: string | null, fallback: number) {
  if (!value) return fallback;
  const [kind, amount] = value.split(":");
  const days = Number(amount);
  if (!Number.isFinite(days) || days < 0) return fallback;
  if (kind === "recent") return -days;
  if (kind === "inactive") return days;
  return fallback;
}

function readUrlViewState(searchParams: Pick<URLSearchParams, "get" | "getAll">, fallback: DashboardViewState): DashboardViewState {
  const scope = searchParams.get("scope");
  const workState = searchParams.get("state");
  const wipFilter = searchParams.get("wip");
  const sort = searchParams.get("sort");
  return {
    ...fallback,
    scope: scope === "all" || scope === "mine" || scope === "reviewing" || scope === "everything" ? scope : fallback.scope,
    workState: workState === "all" || GROUPS.some((group) => group.id === workState) ? workState as "all" | DashboardGroup : fallback.workState,
    wipFilter: wipFilter === "wip" || wipFilter === "reviewable" ? wipFilter : fallback.wipFilter,
    project: searchParams.get("project") ?? fallback.project,
    owners: searchParams.getAll("owner").flatMap((value) => value.split(",")).filter((value) => value && value !== "all").filter((value, index, values) => values.indexOf(value) === index),
    topic: searchParams.get("topic") ?? fallback.topic,
    sort: sort === "freshest" || sort === "oldest" ? sort : fallback.sort,
    activityAgeFilter: parseActivityAge(searchParams.get("age"), fallback.activityAgeFilter),
  };
}

function dashboardSearchParams(profile: DashboardProfile, state: DashboardViewState, accountId?: number, includeIdentity = true) {
  const params = new URLSearchParams();
  if (includeIdentity) {
    params.set("server", profile.server);
    params.set("user", profile.username);
    if (accountId !== undefined) params.set("account", String(accountId));
  }
  params.set("scope", state.scope);
  params.set("state", state.workState);
  if (state.wipFilter !== "all") params.set("wip", state.wipFilter);
  if (state.project !== "all") params.set("project", state.project);
  for (const owner of state.owners) params.append("owner", owner);
  if (state.topic !== "all") params.set("topic", state.topic);
  if (state.sort !== "priority") params.set("sort", state.sort);
  if (state.activityAgeFilter > 0) params.set("age", `inactive:${state.activityAgeFilter}`);
  if (state.activityAgeFilter < 0) params.set("age", `recent:${Math.abs(state.activityAgeFilter)}`);
  return params;
}

const GROUPS: { id: DashboardGroup; label: string; hint: string }[] = [
  { id: "action", label: "Needs your action", hint: "explicit blockers, then oldest first" },
  { id: "unclear", label: "Unclear · you decide", hint: "insufficient evidence for a confident turn" },
  { id: "waiting", label: "Waiting on others", hint: "surface stale waits as nudges" },
  { id: "ready-stuck", label: "Ready but stuck", hint: "this change is ready, but its stack is not" },
  { id: "ready", label: "Ready", hint: "all known requirements satisfied" },
  { id: "merged", label: "Merged", hint: "submitted changes, newest first" },
];

export function DashboardProfileForm({ onSave }: { onSave(profile: DashboardProfile): void }) {
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");

  function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    try {
      const profile = { server: normalizeGerritServer(server).toString(), username: username.trim() };
      if (!profile.username) throw new Error("Enter your Gerrit username.");
      if (!/^[A-Za-z0-9._@+-]+$/.test(profile.username)) throw new Error("Enter an exact username, email, or numeric account ID.");
      onSave(profile);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Check the profile details.");
    }
  }

  return (
    <form className="profile-form" onSubmit={submit}>
      <div className="profile-form-copy">
        <strong>Open your public review dashboard</strong>
        <span>No sign-in. GerritDiff only reads anonymously visible changes.</span>
      </div>
      <label>
        <span>Gerrit server</span>
        <input value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://gerrit.example.com" inputMode="url" spellCheck={false} />
      </label>
      <label>
        <span>Username</span>
        <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="arthur" autoComplete="username" spellCheck={false} />
      </label>
      <button type="submit">View my work</button>
      {error && <p className="profile-form-error">{error}</p>}
    </form>
  );
}

function parseTime(value: string) {
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T").replace(/(\.\d{3})\d+$/, "$1")}Z`;
  return Date.parse(normalized);
}

function relativeAge(updated: string) {
  const timestamp = parseTime(updated);
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return { label: `${Math.max(1, minutes)}m`, days: 0, timestamp };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { label: `${hours}h`, days: 0, timestamp };
  const days = Math.floor(hours / 24);
  if (days >= 365) return { label: `${(days / 365).toFixed(1)}y`, days, timestamp };
  if (days >= 60) return { label: `${Math.floor(days / 30)}mo`, days, timestamp };
  return { label: `${days}d`, days, timestamp };
}

function displayServer(server: string) {
  const url = normalizeGerritServer(server);
  return `${url.host}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`;
}

function viewStateKey(profile: DashboardProfile) {
  return `gerritdiff:dashboard-view:${profile.server}:${profile.username}`;
}

function readViewState(profile: DashboardProfile): DashboardViewState {
  if (typeof window === "undefined") return DEFAULT_VIEW_STATE;
  try {
    return { ...DEFAULT_VIEW_STATE, ...JSON.parse(window.sessionStorage.getItem(viewStateKey(profile)) ?? "{}") } as DashboardViewState;
  } catch {
    return DEFAULT_VIEW_STATE;
  }
}

function saveViewState(profile: DashboardProfile, state: DashboardViewState) {
  window.sessionStorage.setItem(viewStateKey(profile), JSON.stringify({ scrollY: state.scrollY }));
}

const DASHBOARD_CACHE_VERSION = 7;
const DASHBOARD_DATA_EVENT = "gerritdiff:dashboard-data-change";

function dashboardDataKey(profile: DashboardProfile) {
  return `gerritdiff:dashboard-data:v${DASHBOARD_CACHE_VERSION}:${profile.server}:${profile.username}`;
}

function subscribeDashboardData(listener: () => void) {
  window.addEventListener(DASHBOARD_DATA_EVENT, listener);
  return () => window.removeEventListener(DASHBOARD_DATA_EVENT, listener);
}

function subscribeHydration() {
  return () => {};
}

function dashboardDataSnapshot(profile: DashboardProfile) {
  return window.sessionStorage.getItem(dashboardDataKey(profile)) ?? "";
}

function parseDashboardDataSnapshot(value: string): DashboardData | null {
  try {
    const data = JSON.parse(value || "null") as DashboardData | null;
    if (!data || Date.now() - Date.parse(data.fetchedAt) > 24 * 60 * 60 * 1_000) return null;
    return data;
  } catch {
    return null;
  }
}

function readDashboardData(profile: DashboardProfile) {
  if (typeof window === "undefined") return null;
  return parseDashboardDataSnapshot(dashboardDataSnapshot(profile));
}

function saveDashboardData(profile: DashboardProfile, data: DashboardData) {
  try {
    window.sessionStorage.setItem(dashboardDataKey(profile), JSON.stringify(data));
    window.dispatchEvent(new Event(DASHBOARD_DATA_EVENT));
  } catch {
    // A full dashboard can exceed restrictive browser storage quotas; live data still works.
  }
}

function ownershipLabel(ownership: DashboardOwnership | null, loading: boolean, error: string, accountId?: number) {
  if (!accountId) return "Account identity is not precise enough to check ownership";
  if (loading) return "Checking the owners plugin…";
  if (error) return error;
  if (!ownership) return "Ownership has not been checked for the current dashboard data";
  if (ownership.status === "unavailable") return "This Gerrit server does not expose compatible ownership data";
  if (ownership.status === "approved") return "The owner requirement is already satisfied";
  if (ownership.status === "owner-all") return `You own all ${ownership.pendingPaths} file${ownership.pendingPaths === 1 ? "" : "s"} awaiting owner approval`;
  if (ownership.status === "owner-some") return `You own ${ownership.ownedPaths} of ${ownership.pendingPaths} files awaiting owner approval`;
  const owners = ownership.eligibleOwners.slice(0, 3).join(", ");
  return owners ? `You are not an owner for the pending files · Eligible: ${owners}` : "You are not an owner for the pending files";
}

function confidenceLabel(change: DashboardChange) {
  if (change.evidence === "explicit") return "Reported directly by Gerrit";
  if (change.evidence === "derived") return "Computed from complete Gerrit data";
  if (change.evidence === "inferred") return "Best guess from available activity";
  return "Not enough data for a confident conclusion";
}

function changeMatchesScope(change: DashboardChange, scope: "all" | DashboardScope, ownerFilterActive = false) {
  if (scope === "everything" || (scope === "all" && ownerFilterActive)) return true;
  if (scope === "all") return change.scopes.includes("mine") || change.scopes.includes("reviewing");
  return change.scopes.includes(scope);
}

function ChangeRow({
  change,
  href,
  ownerHref,
  abandonSelected,
  identityAccountId,
  ownershipRevision,
  onOpen,
  onOpenOwner,
  onToggleAbandon,
}: {
  change: DashboardChange;
  href: string;
  ownerHref: string;
  abandonSelected: boolean;
  identityAccountId?: number;
  ownershipRevision: string;
  onOpen(change: DashboardChange): void;
  onOpenOwner(change: DashboardChange): void;
  onToggleAbandon(change: DashboardChange): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [ownershipState, setOwnershipState] = useState<{ revision: string; value: DashboardOwnership | null; error: string }>({ revision: "", value: null, error: "" });
  const [ownershipLoadingRevision, setOwnershipLoadingRevision] = useState<string | null>(null);
  const ownershipController = useRef<AbortController | null>(null);
  const ownership = ownershipState.revision === ownershipRevision ? ownershipState.value : null;
  const ownershipError = ownershipState.revision === ownershipRevision ? ownershipState.error : "";
  const ownershipLoading = ownershipLoadingRevision === ownershipRevision;
  const changeAge = relativeAge(change.updated);
  const scope = change.scopes.includes("mine") ? "Mine" : change.scopes.includes("reviewing") ? "Reviewing" : "Everything";
  const needsOwnerApproval = change.requirements.some((requirement) => requirement.status === "UNSATISFIED" && /owner/i.test(requirement.name));

  useEffect(() => () => ownershipController.current?.abort(), []);

  async function loadOwnership() {
    if (!needsOwnerApproval || !identityAccountId || ownershipLoading) return;
    ownershipController.current?.abort();
    const controller = new AbortController();
    ownershipController.current = controller;
    setOwnershipLoadingRevision(ownershipRevision);
    setOwnershipState({ revision: ownershipRevision, value: null, error: "" });
    try {
      const response = await fetch(`/api/dashboard/ownership?server=${encodeURIComponent(change.sourceUrl)}&change=${change.changeNumber}&account=${identityAccountId}`, { signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Ownership could not be checked.");
      if (!controller.signal.aborted) setOwnershipState({ revision: ownershipRevision, value: body as DashboardOwnership, error: "" });
    } catch (reason) {
      if (!controller.signal.aborted) setOwnershipState({ revision: ownershipRevision, value: null, error: reason instanceof Error ? reason.message : "Ownership could not be checked." });
    } finally {
      if (!controller.signal.aborted) setOwnershipLoadingRevision(null);
    }
  }

  function toggleDetails() {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded && (!ownership || ownership.status === "unavailable")) loadOwnership();
  }

  return (
    <article className={`dashboard-change dashboard-change-${change.group} evidence-${change.evidence}${change.status === "WIP" ? " is-wip" : ""}`}>
      <div className="dashboard-change-main">
        <a className="dashboard-change-link-overlay" href={href} aria-label={`Open ${change.subject}`} onClick={(event) => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpen(change);
        }} />
        <span className="dashboard-change-title">
          <strong>{change.subject}</strong>
          <small>{change.project} #{change.changeNumber}{change.patchset ? ` · PS${change.patchset}` : ""} · {scope}{change.status === "WIP" && <b className="dashboard-wip-badge">WIP</b>}{change.topic ? ` · ${change.topic}` : ""}</small>
        </span>
        <span className="dashboard-change-reason">
          <strong>{change.facts.join(" · ") || "Details pending"}</strong>
          <span>{change.evidence === "inferred" ? "Likely: " : ""}{change.diagnosis}</span>
        </span>
        <span className="dashboard-change-owner"><small>Owner</small><a href={ownerHref} onClick={(event) => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpenOwner(change);
        }}>{change.owner.name}</a></span>
        <time className={changeAge.days >= 7 ? "overdue" : changeAge.days >= 3 ? "stale" : ""} dateTime={change.updated} title={`Last updated ${new Date(changeAge.timestamp).toLocaleString()}`}>Updated {changeAge.label}</time>
      </div>
      <button className="dashboard-change-expand" type="button" aria-expanded={expanded} aria-label={expanded ? "Collapse change details" : "Expand change details"} onClick={toggleDetails}>
        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {expanded && (
        <div className="dashboard-change-details">
          <div><span>Owner</span><a className="dashboard-person-link" href={ownerHref} onClick={(event) => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onOpenOwner(change);
          }}>{change.owner.name}</a></div>
          <div><span>Branch</span><strong>{change.branch}</strong></div>
          <div><span>Why this status?</span><strong>{confidenceLabel(change)}</strong></div>
          {needsOwnerApproval && <div className="dashboard-ownership"><span>Owner requirement</span><strong>{ownershipLabel(ownership, ownershipLoading, ownershipError, identityAccountId)}</strong></div>}
          <div><span>Topic</span><strong>{change.topic ?? "No topic"}</strong></div>
          <div><span>Updated</span><strong>{new Date(parseTime(change.updated)).toLocaleString()}</strong></div>
          <div className="dashboard-change-detail-actions">
            {needsOwnerApproval && identityAccountId && !ownershipLoading && (ownershipError || !ownership || ownership.status === "unavailable") && <button type="button" onClick={loadOwnership}>Retry ownership check</button>}
            <a href={href} onClick={(event) => {
              if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onOpen(change);
            }}>Open diff</a>
            <a href={change.sourceUrl} target="_blank" rel="noreferrer">Open in Gerrit <ExternalLink size={12} /></a>
            {change.scopes.includes("mine") && change.patchset && (
              <button type="button" className={abandonSelected ? "is-danger" : ""} onClick={() => onToggleAbandon(change)}>
                {abandonSelected ? "Remove from abandonment queue" : "Flag for abandonment"}
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function shellArg(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function abandonmentCommand(changes: DashboardChange[], messages: Record<string, string>, username: string, host: string, port: string) {
  const target = shellArg(`${username}@${host}`);
  return changes.flatMap((change) => {
    if (!change.patchset) return [];
    const message = messages[change.id]?.trim();
    const messageArgument = message ? ` -m ${shellArg(message)}` : "";
    return [`ssh -p ${port} ${target} gerrit review --abandon${messageArgument} ${change.changeNumber},${change.patchset}`];
  }).join(" && \\\n  ");
}

function Group({
  group,
  changes,
  warning,
  abandonQueue,
  identityAccountId,
  ownershipRevision,
  changeHref,
  ownerHref,
  onOpen,
  onOpenOwner,
  onToggleAbandon,
}: {
  group: (typeof GROUPS)[number];
  changes: DashboardChange[];
  warning?: string;
  abandonQueue: Record<string, string>;
  identityAccountId?: number;
  ownershipRevision: string;
  changeHref(change: DashboardChange): string;
  ownerHref(change: DashboardChange): string;
  onOpen(change: DashboardChange): void;
  onOpenOwner(change: DashboardChange): void;
  onToggleAbandon(change: DashboardChange): void;
}) {
  return (
    <section className={`dashboard-group dashboard-group-${group.id}`}>
      <div className="dashboard-group-head">
        <span>{group.label}</span><b>{changes.length}</b>
        <small className={warning ? "warning" : ""}>{warning ?? group.hint}</small>
      </div>
      <div className="dashboard-group-list">
        {changes.length > 0 ? changes.map((change) => (
          <ChangeRow key={change.id} change={change} href={changeHref(change)} ownerHref={ownerHref(change)} abandonSelected={Object.hasOwn(abandonQueue, change.id)} identityAccountId={identityAccountId} ownershipRevision={ownershipRevision} onOpen={onOpen} onOpenOwner={onOpenOwner} onToggleAbandon={onToggleAbandon} />
        )) : (
          <div className="dashboard-group-empty">No changes in this group.</div>
        )}
      </div>
    </section>
  );
}

function OwnerMultiSelect({
  options,
  selected,
  onChange,
}: {
  options: [string, string][];
  selected: string[];
  onChange(selected: string[]): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    window.addEventListener("pointerdown", closeOnOutsideClick);
    return () => window.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  const knownOwners = new Map(options);
  const completeOptions: [string, string][] = [
    ...selected.flatMap((value): [string, string][] => knownOwners.has(value) ? [] : [[value, value]]),
    ...options,
  ];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchesQuery = ([value, label]: [string, string]) => !normalizedQuery
    || label.toLocaleLowerCase().includes(normalizedQuery)
    || value.toLocaleLowerCase().includes(normalizedQuery);
  const selectedOptions = completeOptions.filter((option) => selected.includes(option[0]) && matchesQuery(option));
  const remainingOptions = completeOptions.filter((option) => !selected.includes(option[0]) && matchesQuery(option));
  const selectedLabels = completeOptions.flatMap(([value, label]) => selected.includes(value) ? [label] : []);
  const buttonLabel = selected.length === 0
    ? "All owners"
    : selected.length === 1
      ? selectedLabels[0] ?? selected[0]
      : `${selected.length} owners`;

  function toggleOwner(value: string) {
    onChange(selected.includes(value)
      ? selected.filter((owner) => owner !== value)
      : [...selected, value]);
  }

  function ownerOption([value, label]: [string, string]) {
    return (
      <label key={value}>
        <input type="checkbox" checked={selected.includes(value)} onChange={() => toggleOwner(value)} />
        <span>{label}</span>
      </label>
    );
  }

  return (
    <div className="dashboard-multiselect" ref={container}>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => {
        if (open) setQuery("");
        setOpen(!open);
      }}>
        <span>{buttonLabel}</span><ChevronDown size={13} />
      </button>
      {open && (
        <div className="dashboard-multiselect-list" role="listbox" aria-label="Filter by change owners" aria-multiselectable="true">
          <label className="dashboard-multiselect-search">
            <Search size={13} />
            <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search owners" aria-label="Search change owners" />
          </label>
          {selected.length > 0 && (
            <>
              <div className="dashboard-multiselect-group"><span>Selected</span><button type="button" onClick={() => onChange([])}>Clear</button></div>
              {selectedOptions.map(ownerOption)}
            </>
          )}
          <div className="dashboard-multiselect-group"><span>{selected.length > 0 ? "Other owners" : "Owners"}</span></div>
          {remainingOptions.map(ownerOption)}
          {selectedOptions.length === 0 && remainingOptions.length === 0 && <small>No matching owners.</small>}
        </div>
      )}
    </div>
  );
}

export function Dashboard({ profile, onForget, sharedIdentity = false }: { profile: DashboardProfile; onForget(): void; sharedIdentity?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { server: profileServer, username: profileUsername, accountId: profileAccountId } = profile;
  // Navigation and filter controls share one source of truth, including Back/Forward.
  const viewState = useMemo(() => readUrlViewState(searchParams, DEFAULT_VIEW_STATE), [searchParams]);
  const initialScrollY = useMemo(() => readViewState(profile).scrollY, [profile]);
  const hydrated = useSyncExternalStore(subscribeHydration, () => true, () => false);
  const cachedSnapshot = useSyncExternalStore(subscribeDashboardData, () => dashboardDataSnapshot(profile), () => "");
  const cachedData = useMemo(() => parseDashboardDataSnapshot(cachedSnapshot), [cachedSnapshot]);
  const dataRef = useRef<DashboardData | null>(null);
  const [liveData, setLiveData] = useState<DashboardData | null>(null);
  const fetchedData = liveData ?? cachedData;
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const { scope, workState, wipFilter, project, owners: selectedOwners, topic, sort, activityAgeFilter } = viewState;
  const mergedView = workState === "merged";
  const data = fetchedData && Boolean(fetchedData.mergedLoaded) === mergedView ? fetchedData : null;
  const [abandonQueue, setAbandonQueue] = useState<Record<string, string>>({});
  const [sshHost, setSshHost] = useState(() => normalizeGerritServer(profile.server).hostname);
  const [sshPort, setSshPort] = useState("29418");
  const [commandCopied, setCommandCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState<"exact" | "filters" | null>(null);

  useEffect(() => {
    saveViewState(profile, { ...viewState, scrollY: window.scrollY });
    const canonical = dashboardSearchParams(profile, viewState, profile.accountId);
    const target = `/dashboard?${canonical}`;
    if (pathname !== "/dashboard" || searchParams.toString() !== canonical.toString()) router.replace(target, { scroll: false });
  }, [pathname, profile, router, searchParams, viewState]);

  function updateView(update: Partial<DashboardViewState>) {
    const next = { ...viewState, ...update };
    router.replace(`/dashboard?${dashboardSearchParams(profile, next, profile.accountId)}`, { scroll: false });
  }

  useEffect(() => {
    if (!data || initialScrollY <= 0) return;
    const frame = requestAnimationFrame(() => window.scrollTo({ top: initialScrollY }));
    return () => cancelAnimationFrame(frame);
  }, [data, initialScrollY]);

  useEffect(() => {
    const controller = new AbortController();
    setIsRefreshing(true);
    const requestProfile = { server: profileServer, username: profileUsername, accountId: profileAccountId };
    const identityQuery = profileAccountId === undefined ? "" : `&account=${profileAccountId}`;
    const scopeQuery = scope === "everything" ? "&scope=everything" : "";
    const stateQuery = mergedView ? "&state=merged" : "";
    const ownerQuery = selectedOwners.map((owner) => `&owner=${encodeURIComponent(owner)}`).join("");
    const freshQuery = refresh > 0 ? `&fresh=${refresh}` : "";
    // Keep this request version paired with DASHBOARD_CACHE_VERSION so API shape changes also invalidate session data.
    fetch(`/api/dashboard?v=${DASHBOARD_CACHE_VERSION}&server=${encodeURIComponent(profileServer)}&username=${encodeURIComponent(profileUsername)}${identityQuery}${scopeQuery}${stateQuery}${ownerQuery}${freshQuery}`, {
      signal: controller.signal,
      cache: refresh > 0 ? "no-store" : "default",
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "The dashboard could not be loaded.");
        return body as DashboardData;
      })
      .then((nextData) => {
        dataRef.current = nextData;
        setLiveData(nextData);
        if (selectedOwners.length === 0) saveDashboardData(requestProfile, nextData);
        setError("");
        setRefreshError("");
        setIsRefreshing(false);
      })
      .catch((reason) => {
        if (reason.name === "AbortError") return;
        if (dataRef.current || readDashboardData(requestProfile)) setRefreshError(reason.message);
        else setError(reason.message);
        setIsRefreshing(false);
      });
    return () => controller.abort();
  }, [mergedView, profileAccountId, profileServer, profileUsername, refresh, scope, selectedOwners]);

  function currentViewState(): DashboardViewState {
    return { scope, workState, wipFilter, project, owners: selectedOwners, topic, sort, activityAgeFilter, scrollY: window.scrollY };
  }

  function changeHref(change: DashboardChange) {
    const state = { scope, workState, wipFilter, project, owners: selectedOwners, topic, sort, activityAgeFilter, scrollY: 0 };
    const returnTo = `/dashboard?${dashboardSearchParams(profile, state, data?.identity.accountId ?? profile.accountId)}`;
    return `/?${new URLSearchParams({ url: change.sourceUrl, return: returnTo })}`;
  }

  function openChange(change: DashboardChange) {
    const state = currentViewState();
    saveViewState(profile, state);
    router.push(changeHref(change));
  }

  function ownerHref(change: DashboardChange) {
    const owner = change.owner.email ?? change.owner.username ?? change.owner.name;
    const state: DashboardViewState = { ...DEFAULT_VIEW_STATE, scope: "all", workState: "all", owners: [owner], sort, scrollY: 0 };
    return `/dashboard?${dashboardSearchParams(profile, state, data?.identity.accountId ?? profile.accountId)}`;
  }

  function openOwner(change: DashboardChange) {
    router.push(ownerHref(change));
  }

  async function copyDashboardLink(kind: "exact" | "filters") {
    const params = dashboardSearchParams(profile, currentViewState(), data?.identity.accountId ?? profile.accountId, kind === "exact");
    const url = new URL(`/dashboard?${params}`, window.location.origin);
    try {
      await navigator.clipboard.writeText(url.toString());
      setShareCopied(kind);
    } catch {
      setShareCopied(null);
    }
  }

  function reload() {
    setError("");
    setRefreshError("");
    setIsRefreshing(true);
    setRefresh((current) => current + 1);
  }

  function toggleAbandon(change: DashboardChange) {
    setAbandonQueue((current) => {
      if (Object.hasOwn(current, change.id)) {
        const { [change.id]: removed, ...rest } = current;
        void removed;
        return rest;
      }
      return { ...current, [change.id]: "" };
    });
    setCommandCopied(false);
  }

  const projects = useMemo(() => [...new Set(data?.changes.map((change) => change.project) ?? [])].sort(), [data]);
  const projectFiltered = useMemo(() => (data?.changes ?? []).filter((change) => {
    if (project !== "all" && change.project !== project) return false;
    const days = relativeAge(change.updated).days;
    if (activityAgeFilter > 0) return days >= activityAgeFilter;
    if (activityAgeFilter < 0) return days <= Math.abs(activityAgeFilter);
    return true;
  }), [activityAgeFilter, data, project]);
  const ownerOptions = useMemo(() => [...new Map(projectFiltered.map((change) => [change.owner.email ?? change.owner.username ?? change.owner.name, change.owner.name])).entries()]
    .toSorted((left, right) => left[1].localeCompare(right[1])), [projectFiltered]);
  const selectedOwnerSet = useMemo(() => new Set(selectedOwners), [selectedOwners]);
  const ownerFiltered = useMemo(() => projectFiltered.filter((change) => (
    selectedOwnerSet.size === 0 || selectedOwnerSet.has(change.owner.email ?? change.owner.username ?? change.owner.name)
  )), [projectFiltered, selectedOwnerSet]);
  const ownerFilterActive = selectedOwnerSet.size > 0;
  const topicOptionsSource = useMemo(() => ownerFiltered.filter((change) => changeMatchesScope(change, scope, ownerFilterActive)), [ownerFilterActive, ownerFiltered, scope]);
  const topics = useMemo(() => [...new Set(topicOptionsSource.flatMap((change) => change.topic ? [change.topic] : []))].sort(), [topicOptionsSource]);
  const topicFiltered = useMemo(() => ownerFiltered.filter((change) => topic === "all" || change.topic === topic), [ownerFiltered, topic]);
  const scopedForWipCounts = useMemo(() => topicFiltered.filter((change) => changeMatchesScope(change, scope, ownerFilterActive)), [ownerFilterActive, scope, topicFiltered]);
  const wipCounts = {
    all: scopedForWipCounts.length,
    wip: scopedForWipCounts.filter((change) => change.status === "WIP").length,
    reviewable: scopedForWipCounts.filter((change) => change.status !== "WIP").length,
  };
  const wipFiltered = useMemo(() => topicFiltered.filter((change) => (
    wipFilter === "all" || (wipFilter === "wip" ? change.status === "WIP" : change.status !== "WIP")
  )), [topicFiltered, wipFilter]);
  const counts = {
    all: ownerFilterActive ? wipFiltered.length : wipFiltered.filter((change) => change.scopes.includes("mine") || change.scopes.includes("reviewing")).length,
    mine: wipFiltered.filter((change) => change.scopes.includes("mine")).length,
    reviewing: wipFiltered.filter((change) => change.scopes.includes("reviewing")).length,
    everything: wipFiltered.length,
  };
  const scoped = useMemo(() => wipFiltered.filter((change) => changeMatchesScope(change, scope, ownerFilterActive)), [ownerFilterActive, scope, wipFiltered]);
  const stateCounts = Object.fromEntries(GROUPS.map(({ id }) => [id, scoped.filter((change) => change.group === id).length])) as Record<DashboardGroup, number>;
  const visible = useMemo(() => scoped.filter((change) => workState === "all" || change.group === workState), [scoped, workState]);
  const grouped = useMemo(() => Object.fromEntries(GROUPS.map(({ id }) => [
    id,
    visible.filter((change) => change.group === id).sort((left, right) => {
      const difference = parseTime(left.updated) - parseTime(right.updated);
      if (sort === "freshest") return -difference;
      if (sort === "oldest") return difference;
      return id === "ready" || id === "ready-stuck" || id === "merged" ? -difference : difference;
    }),
  ])) as Record<DashboardGroup, DashboardChange[]>, [sort, visible]);
  const queryWarning = data?.warnings.find((warning) => warning.source === "attention" || warning.source === "reviewing");
  const abandonChanges = (data?.changes ?? []).filter((change) => Object.hasOwn(abandonQueue, change.id));
  const generatedAbandonCommand = abandonmentCommand(abandonChanges, abandonQueue, profile.username, sshHost, sshPort);
  const activeGroup = GROUPS.find((group) => group.id === workState);
  const headingCount = activeGroup ? grouped[activeGroup.id].length : visible.length;
  const allStatesCount: number | "?" = data && !data.mergedLoaded ? scoped.length : "?";
  const workStateCount = (group: DashboardGroup): number | "?" => {
    if (!data) return "?";
    if (group === "merged") return data.mergedLoaded ? stateCounts.merged : "?";
    return data.mergedLoaded ? "?" : stateCounts[group];
  };

  async function copyAbandonmentCommand() {
    try {
      await navigator.clipboard.writeText(generatedAbandonCommand);
      setCommandCopied(true);
    } catch {
      setCommandCopied(false);
    }
  }

  return (
    <main className="dashboard-page">
      <header className="dashboard-topbar">
        <Logo />
        <UrlForm compact />
        <div className="dashboard-topbar-actions">
          <span className="dashboard-identity"><b>{displayServer(profile.server)}</b><small>{sharedIdentity ? "Viewing shared dashboard as" : "Viewing as"} {data?.identity.name ?? profile.username}</small></span>
          <button className="icon-button" type="button" aria-label="Change dashboard profile" onClick={onForget}><Settings2 size={16} /></button>
          <ThemeButton />
        </div>
      </header>
      <div className="dashboard-workspace">
        <aside className="dashboard-sidebar">
          <section>
            <h2>Scope</h2>
            {(["all", "mine", "reviewing", "everything"] as const).map((value) => (
              <button key={value} type="button" className={scope === value ? "active" : ""} onClick={() => updateView({ scope: value, topic: "all" })}>
                <span>{value === "all" ? "All work" : value === "mine" ? "Mine" : value === "reviewing" ? "Reviewing" : "Everything"}</span><b>{counts[value]}</b>
              </button>
            ))}
          </section>
          <section>
            <h2>Work state</h2>
            <button type="button" className={workState === "all" ? "active" : ""} onClick={() => updateView({ workState: "all" })}><span>All states</span><b title={allStatesCount === "?" ? "Not fetched for the current view" : undefined}>{allStatesCount}</b></button>
            {GROUPS.map((group) => (
              <button key={group.id} type="button" className={workState === group.id ? "active" : ""} onClick={() => updateView({ workState: group.id })}>
                <span>{group.label.replace(" · you decide", "")}</span><b title={workStateCount(group.id) === "?" ? "Not fetched for the current view" : undefined}>{workStateCount(group.id)}</b>
              </button>
            ))}
          </section>
          <section>
            <h2>Review state</h2>
            {(["all", "wip", "reviewable"] as const).map((value) => (
              <button key={value} type="button" className={wipFilter === value ? "active" : ""} onClick={() => updateView({ wipFilter: value })}>
                <span>{value === "all" ? "All changes" : value === "wip" ? "Work in progress" : "Ready for review"}</span><b>{wipCounts[value]}</b>
              </button>
            ))}
          </section>
          {abandonChanges.length > 0 && <div className="dashboard-sidebar-queue"><span>Flagged for abandonment</span><b>{abandonChanges.length}</b></div>}
        </aside>
        <div className="dashboard-shell">
        <div className="dashboard-heading">
          <div>
            <h1>{activeGroup ? activeGroup.label.replace(" · you decide", "") : "My work"}</h1>
            <p>{headingCount} change{headingCount === 1 ? "" : "s"} in view · {activeGroup?.hint ?? "all open work states"} · public changes only</p>
          </div>
          <div className="dashboard-heading-actions">
            <button type="button" onClick={() => copyDashboardLink("exact")}><Share2 size={13} /> {shareCopied === "exact" ? "Copied exact view" : "Share exact view"}</button>
            <button type="button" onClick={() => copyDashboardLink("filters")}><Share2 size={13} /> {shareCopied === "filters" ? "Copied filter view" : "Share filters"}</button>
            <button type="button" className="dashboard-refresh" onClick={reload} disabled={hydrated && isRefreshing}>
              <RefreshCw size={13} className={hydrated && isRefreshing ? "spinner" : ""} />
              {data ? `Refreshed ${relativeAge(data.fetchedAt).label} ago` : "Refresh"}
            </button>
          </div>
        </div>

        <div className="dashboard-controls">
          <select aria-label="Filter by project" value={project} onChange={(event) => updateView({ project: event.target.value, topic: "all" })}>
            <option value="all">All projects</option>
            {projects.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <OwnerMultiSelect options={ownerOptions} selected={selectedOwners} onChange={(selected) => updateView({ owners: selected, topic: "all" })} />
          <select aria-label="Filter by topic" value={topic} onChange={(event) => updateView({ topic: event.target.value })}>
            <option value="all">All topics</option>
            {topics.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="Filter by time since latest Gerrit activity" value={activityAgeFilter} onChange={(event) => updateView({ activityAgeFilter: Number(event.target.value) })}>
            <option value={0}>Any activity age</option>
            <optgroup label="Recently active">
              <option value={-1}>Updated within 1 day</option>
              <option value={-3}>Updated within 3 days</option>
              <option value={-7}>Updated within 7 days</option>
              <option value={-14}>Updated within 14 days</option>
              <option value={-30}>Updated within 1 month</option>
              <option value={-60}>Updated within 2 months</option>
              <option value={-180}>Updated within 6 months</option>
            </optgroup>
            <optgroup label="Inactive">
              <option value={1}>Inactive for ≥1 day</option>
              <option value={3}>Inactive for ≥3 days</option>
              <option value={7}>Inactive for ≥7 days</option>
              <option value={14}>Inactive for ≥14 days</option>
              <option value={30}>Inactive for ≥1 month</option>
              <option value={60}>Inactive for ≥2 months</option>
              <option value={180}>Inactive for ≥6 months</option>
            </optgroup>
          </select>
          <select aria-label="Sort changes" value={sort} onChange={(event) => updateView({ sort: event.target.value as typeof sort })}>
            <option value="priority">Priority</option>
            <option value="freshest">Newest activity</option>
            <option value="oldest">Oldest activity</option>
          </select>
        </div>

        {data?.warnings.length ? (
          <div className="dashboard-warning"><AlertTriangle size={14} /><div>{data.warnings.map((warning) => <p key={`${warning.source}:${warning.message}`}><b>{warning.source}:</b> {warning.message}</p>)}</div></div>
        ) : null}
        {refreshError && <div className="dashboard-warning"><AlertTriangle size={14} /><div><p><b>Refresh:</b> {refreshError}. Showing the cached dashboard.</p></div></div>}

        {abandonChanges.length > 0 && (
          <section className="abandon-queue">
            <header>
              <div><strong>Abandonment queue</strong><span>{abandonChanges.length} change{abandonChanges.length === 1 ? "" : "s"} flagged</span></div>
              <button type="button" onClick={() => setAbandonQueue({})}>Clear queue</button>
            </header>
            <div className="abandon-connection">
              <label><span>SSH host</span><input value={sshHost} onChange={(event) => { setSshHost(event.target.value); setCommandCopied(false); }} spellCheck={false} /></label>
              <label><span>SSH port</span><input value={sshPort} onChange={(event) => { setSshPort(event.target.value.replace(/\D/g, "")); setCommandCopied(false); }} inputMode="numeric" /></label>
              <span>Commands use the saved Gerrit username <b>{profile.username}</b>.</span>
            </div>
            <div className="abandon-items">
              {abandonChanges.map((change) => (
                <article key={change.id}>
                  <div><strong>{change.subject}</strong><span>{change.project} #{change.changeNumber}{change.patchset ? ` · PS${change.patchset}` : ""}</span></div>
                  <textarea
                    value={abandonQueue[change.id] ?? ""}
                    onChange={(event) => { setAbandonQueue((current) => ({ ...current, [change.id]: event.target.value })); setCommandCopied(false); }}
                    placeholder="Optional abandonment message for this change"
                    aria-label={`Abandonment message for ${change.subject}`}
                  />
                  <button type="button" onClick={() => toggleAbandon(change)}>Remove</button>
                </article>
              ))}
            </div>
            <div className="abandon-command">
              <div><strong>Combined command</strong><span>Each change gets its own message; execution stops after the first failure.</span></div>
              <pre>{generatedAbandonCommand}</pre>
              <button type="button" disabled={!generatedAbandonCommand || !sshPort} onClick={copyAbandonmentCommand}>{commandCopied ? "Copied" : "Copy all commands"}</button>
            </div>
            <p>GerritDiff remains read-only. This copies SSH commands for you to inspect and run locally; it does not abandon changes in the browser.</p>
          </section>
        )}

        {error ? (
          <div className="dashboard-error">
            <AlertTriangle size={22} /><h2>Couldn&apos;t load this dashboard</h2><p>{error}</p>
            <div><button type="button" onClick={reload}>Try again</button><button type="button" className="secondary" onClick={onForget}>Change profile</button></div>
          </div>
        ) : !data ? (
          <div className="dashboard-loading"><LoaderCircle className="spinner" size={24} /><span>Loading public review work…</span></div>
        ) : data.changes.length === 0 && data.warnings.length === 0 ? (
          <div className="dashboard-empty"><strong>All caught up</strong><span>No matching public open changes were found.</span></div>
        ) : data.changes.length === 0 ? (
          <div className="dashboard-empty is-uncertain"><strong>No verified results</strong><span>One or more queries failed, so this is not an all-clear state.</span></div>
        ) : (
          <div className="dashboard-groups">
            {GROUPS.filter((group) => grouped[group.id].length > 0 || workState === group.id).map((group) => (
              <Group
                key={group.id}
                group={group}
                changes={grouped[group.id]}
                warning={group.id === "unclear" ? queryWarning?.message : undefined}
                abandonQueue={abandonQueue}
                identityAccountId={data?.identity.accountId ?? profile.accountId}
                ownershipRevision={data?.fetchedAt ?? ""}
                changeHref={changeHref}
                ownerHref={ownerHref}
                onOpen={openChange}
                onOpenOwner={openOwner}
                onToggleAbandon={toggleAbandon}
              />
            ))}
          </div>
        )}
        </div>
      </div>
    </main>
  );
}

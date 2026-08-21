"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, LoaderCircle, RefreshCw, Settings2 } from "lucide-react";
import { Logo, ThemeButton, UrlForm } from "@/components/app-chrome";
import { normalizeGerritServer } from "@/lib/gerrit-url";
import type { DashboardChange, DashboardData, DashboardGroup, DashboardProfile, DashboardScope } from "@/lib/types";

const GROUPS: { id: DashboardGroup; label: string; hint: string }[] = [
  { id: "action", label: "Needs your action", hint: "explicit blockers, then oldest first" },
  { id: "unclear", label: "Unclear · you decide", hint: "insufficient evidence for a confident turn" },
  { id: "waiting", label: "Waiting on others", hint: "surface stale waits as nudges" },
  { id: "ready", label: "Ready", hint: "all known requirements satisfied" },
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

function confidenceLabel(change: DashboardChange) {
  if (change.evidence === "explicit") return "Reported directly by Gerrit";
  if (change.evidence === "derived") return "Computed from complete Gerrit data";
  if (change.evidence === "inferred") return "Best guess from available activity";
  return "Not enough data for a confident conclusion";
}

function ChangeRow({
  change,
  abandonSelected,
  onToggleAbandon,
}: {
  change: DashboardChange;
  abandonSelected: boolean;
  onToggleAbandon(change: DashboardChange): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const changeAge = relativeAge(change.updated);
  const scope = change.scopes.includes("mine") ? "Mine" : "Reviewing";

  return (
    <article className={`dashboard-change dashboard-change-${change.group} evidence-${change.evidence}`}>
      <button className="dashboard-change-main" type="button" onClick={() => window.location.assign(`/?url=${encodeURIComponent(change.sourceUrl)}`)}>
        <span className="dashboard-change-title">
          <strong>{change.subject}</strong>
          <small>{change.project} #{change.changeNumber}{change.patchset ? ` · PS${change.patchset}` : ""} · {scope}{change.topic ? ` · ${change.topic}` : ""}{change.scopes.includes("reviewing") ? ` · ${change.owner.name}` : ""}</small>
        </span>
        <span className="dashboard-change-reason">
          <strong>{change.facts.join(" · ") || "Details pending"}</strong>
          <span>{change.evidence === "inferred" ? "Likely: " : ""}{change.diagnosis}</span>
        </span>
        <time className={changeAge.days >= 7 ? "overdue" : changeAge.days >= 3 ? "stale" : ""} dateTime={change.updated} title={`Last updated ${new Date(changeAge.timestamp).toLocaleString()}`}>Updated {changeAge.label}</time>
      </button>
      <button className="dashboard-change-expand" type="button" aria-expanded={expanded} aria-label={expanded ? "Collapse change details" : "Expand change details"} onClick={() => setExpanded((current) => !current)}>
        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {expanded && (
        <div className="dashboard-change-details">
          <div><span>Owner</span><strong>{change.owner.name}</strong></div>
          <div><span>Branch</span><strong>{change.branch}</strong></div>
          <div><span>Why this status?</span><strong>{confidenceLabel(change)}</strong></div>
          <div><span>Topic</span><strong>{change.topic ?? "No topic"}</strong></div>
          <div><span>Updated</span><strong>{new Date(parseTime(change.updated)).toLocaleString()}</strong></div>
          <div className="dashboard-change-detail-actions">
            <button type="button" onClick={() => window.location.assign(`/?url=${encodeURIComponent(change.sourceUrl)}`)}>Open diff</button>
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
    const messageArgument = message ? ` -m ${shellArg(JSON.stringify(message))}` : "";
    return [`ssh -p ${port} ${target} gerrit review --abandon${messageArgument} ${change.changeNumber},${change.patchset}`];
  }).join(" && \\\n  ");
}

function Group({
  group,
  changes,
  warning,
  abandonQueue,
  onToggleAbandon,
}: {
  group: (typeof GROUPS)[number];
  changes: DashboardChange[];
  warning?: string;
  abandonQueue: Record<string, string>;
  onToggleAbandon(change: DashboardChange): void;
}) {
  const [collapsed, setCollapsed] = useState(group.id === "ready");
  return (
    <section className={`dashboard-group dashboard-group-${group.id}${collapsed ? " is-collapsed" : ""}`}>
      <button className="dashboard-group-head" type="button" onClick={() => setCollapsed((current) => !current)}>
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span>{group.label}</span><b>{changes.length}</b>
        <small className={warning ? "warning" : ""}>{warning ?? group.hint}</small>
      </button>
      {!collapsed && (
        <div className="dashboard-group-list">
          {changes.length > 0 ? changes.map((change) => (
            <ChangeRow key={change.id} change={change} abandonSelected={Object.hasOwn(abandonQueue, change.id)} onToggleAbandon={onToggleAbandon} />
          )) : (
            <div className="dashboard-group-empty">No changes in this group.</div>
          )}
        </div>
      )}
    </section>
  );
}

export function Dashboard({ profile, onForget }: { profile: DashboardProfile; onForget(): void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [scope, setScope] = useState<"all" | DashboardScope>("all");
  const [project, setProject] = useState("all");
  const [topic, setTopic] = useState("all");
  const [sort, setSort] = useState<"priority" | "freshest" | "oldest">("priority");
  const [activityAgeFilter, setActivityAgeFilter] = useState(0);
  const [abandonQueue, setAbandonQueue] = useState<Record<string, string>>({});
  const [sshHost, setSshHost] = useState(() => normalizeGerritServer(profile.server).hostname);
  const [sshPort, setSshPort] = useState("29418");
  const [commandCopied, setCommandCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/dashboard?server=${encodeURIComponent(profile.server)}&username=${encodeURIComponent(profile.username)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "The dashboard could not be loaded.");
        return body as DashboardData;
      })
      .then(setData)
      .catch((reason) => {
        if (reason.name !== "AbortError") setError(reason.message);
      });
    return () => controller.abort();
  }, [profile.server, profile.username, refresh]);

  function reload() {
    setError("");
    setData(null);
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
  const topics = useMemo(() => [...new Set(projectFiltered.flatMap((change) => change.topic ? [change.topic] : []))].sort(), [projectFiltered]);
  const filtered = useMemo(() => projectFiltered.filter((change) => topic === "all" || change.topic === topic), [projectFiltered, topic]);
  const visible = useMemo(() => filtered.filter((change) => scope === "all" || change.scopes.includes(scope)), [filtered, scope]);
  const grouped = useMemo(() => Object.fromEntries(GROUPS.map(({ id }) => [
    id,
    visible.filter((change) => change.group === id).sort((left, right) => {
      const difference = parseTime(left.updated) - parseTime(right.updated);
      if (sort === "freshest") return -difference;
      if (sort === "oldest") return difference;
      return id === "ready" ? -difference : difference;
    }),
  ])) as Record<DashboardGroup, DashboardChange[]>, [sort, visible]);
  const queryWarning = data?.warnings.find((warning) => warning.source === "attention" || warning.source === "reviewing");
  const counts = {
    all: filtered.length,
    mine: filtered.filter((change) => change.scopes.includes("mine")).length,
    reviewing: filtered.filter((change) => change.scopes.includes("reviewing")).length,
  };
  const abandonChanges = (data?.changes ?? []).filter((change) => Object.hasOwn(abandonQueue, change.id));
  const generatedAbandonCommand = abandonmentCommand(abandonChanges, abandonQueue, profile.username, sshHost, sshPort);

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
          <span className="dashboard-identity"><b>{displayServer(profile.server)}</b><small>Viewing as {data?.identity.name ?? profile.username}</small></span>
          <button className="icon-button" type="button" aria-label="Change dashboard profile" onClick={onForget}><Settings2 size={16} /></button>
          <ThemeButton />
        </div>
      </header>
      <div className="dashboard-shell">
        <div className="dashboard-heading">
          <div><h1>My work</h1><p>{grouped.action.length} need action · {grouped.unclear.length} need triage · public changes only</p></div>
          <button type="button" className="dashboard-refresh" onClick={reload} disabled={!data && !error}>
            <RefreshCw size={13} className={!data && !error ? "spinner" : ""} />
            {data ? `Refreshed ${relativeAge(data.fetchedAt).label} ago` : "Refresh"}
          </button>
        </div>

        <div className="dashboard-controls">
          <div className="dashboard-scope" aria-label="Change scope">
            {(["all", "mine", "reviewing"] as const).map((value) => (
              <button key={value} type="button" className={scope === value ? "active" : ""} onClick={() => setScope(value)}>
                {value === "all" ? "All" : value === "mine" ? "Mine" : "Reviewing"} <b>{counts[value]}</b>
              </button>
            ))}
          </div>
          <select aria-label="Filter by project" value={project} onChange={(event) => { setProject(event.target.value); setTopic("all"); }}>
            <option value="all">All projects</option>
            {projects.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="Filter by topic" value={topic} onChange={(event) => setTopic(event.target.value)}>
            <option value="all">All topics</option>
            {topics.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="Filter by time since latest Gerrit activity" value={activityAgeFilter} onChange={(event) => setActivityAgeFilter(Number(event.target.value))}>
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
          <select aria-label="Sort changes" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
            <option value="priority">Priority</option>
            <option value="freshest">Newest activity</option>
            <option value="oldest">Oldest activity</option>
          </select>
        </div>

        {data?.warnings.length ? (
          <div className="dashboard-warning"><AlertTriangle size={14} /><div>{data.warnings.map((warning) => <p key={`${warning.source}:${warning.message}`}><b>{warning.source}:</b> {warning.message}</p>)}</div></div>
        ) : null}

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
            {GROUPS.map((group) => (
              <Group
                key={group.id}
                group={group}
                changes={grouped[group.id]}
                warning={group.id === "unclear" ? queryWarning?.message : undefined}
                abandonQueue={abandonQueue}
                onToggleAbandon={toggleAbandon}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

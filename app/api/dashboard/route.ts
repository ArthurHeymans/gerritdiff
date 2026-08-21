import { NextRequest, NextResponse } from "next/server";
import { parseGerritJson, publicFetch } from "@/lib/gerrit-server";
import { normalizeGerritServer } from "@/lib/gerrit-url";
import type {
  DashboardChange,
  DashboardCiState,
  DashboardData,
  DashboardScope,
  DashboardWarning,
} from "@/lib/types";

type GerritAccount = {
  _account_id?: number;
  name?: string;
  username?: string;
  avatars?: { url: string; height: number }[];
};

type GerritLabel = {
  approved?: GerritAccount;
  rejected?: GerritAccount;
  all?: (GerritAccount & { value?: number })[];
};

type GerritSubmitRequirement = {
  name: string;
  status: "SATISFIED" | "UNSATISFIED" | "OVERRIDDEN" | "NOT_APPLICABLE" | "ERROR";
};

type GerritChange = {
  id: string;
  project: string;
  branch: string;
  topic?: string;
  subject: string;
  status: string;
  updated: string;
  _number: number;
  owner: GerritAccount;
  labels?: Record<string, GerritLabel>;
  attention_set?: Record<string, { account: GerritAccount; last_update?: string; reason?: string }>;
  revisions?: Record<string, { _number: number }>;
  current_revision?: string;
  submittable?: boolean;
  mergeable?: boolean;
  work_in_progress?: boolean;
  unresolved_comment_count?: number;
  submit_requirements?: GerritSubmitRequirement[];
  _more_changes?: boolean;
};

type Identity = DashboardData["identity"];

type QueryResult = {
  changes: GerritChange[];
  warning?: string;
};

const QUERY_OPTIONS = ["DETAILED_LABELS", "DETAILED_ACCOUNTS", "CURRENT_REVISION", "SUBMITTABLE", "SUBMIT_REQUIREMENTS"];
const FALLBACK_QUERY_OPTIONS = ["DETAILED_LABELS", "DETAILED_ACCOUNTS", "CURRENT_REVISION"];
const MAX_CHANGES_PER_QUERY = 300;

function endpoint(server: URL, path: string) {
  return new URL(path.replace(/^\/+/, ""), server);
}

async function fetchJson<T>(url: URL) {
  const response = await publicFetch(url.toString());
  if (!response) throw new Error("Gerrit returned no response.");
  const text = await response.text();
  try {
    return parseGerritJson<T>(text);
  } catch {
    if (response.headers.get("content-type")?.includes("text/html") || /^\s*</.test(text)) {
      throw new Error("The saved URL returned a web page instead of Gerrit's REST API. Use the Gerrit server or any Gerrit change URL.");
    }
    throw new Error("Gerrit returned JSON in an unsupported format.");
  }
}

function queryUrl(server: URL, query: string, options: string[], start: number) {
  const url = endpoint(server, "changes/");
  url.searchParams.set("q", query);
  url.searchParams.set("n", "100");
  if (start > 0) url.searchParams.set("S", String(start));
  for (const option of options) url.searchParams.append("o", option);
  return url;
}

async function queryPages(server: URL, query: string, options: string[]) {
  const changes: GerritChange[] = [];
  while (changes.length < MAX_CHANGES_PER_QUERY) {
    const page = await fetchJson<GerritChange[]>(queryUrl(server, query, options, changes.length));
    changes.push(...page);
    if (page.length === 0 || !page.at(-1)?._more_changes) return { changes, truncated: false };
  }
  return { changes: changes.slice(0, MAX_CHANGES_PER_QUERY), truncated: true };
}

async function queryChanges(server: URL, query: string): Promise<QueryResult> {
  try {
    const result = await queryPages(server, query, QUERY_OPTIONS);
    return { changes: result.changes, warning: result.truncated ? `Only the first ${MAX_CHANGES_PER_QUERY} matching changes are shown.` : undefined };
  } catch (reason) {
    try {
      const result = await queryPages(server, query, FALLBACK_QUERY_OPTIONS);
      const details = reason instanceof Error ? reason.message : "unsupported query options";
      const truncation = result.truncated ? ` Only the first ${MAX_CHANGES_PER_QUERY} matching changes are shown.` : "";
      return { changes: result.changes, warning: `Some dashboard details are unavailable: ${details}.${truncation}` };
    } catch (fallbackReason) {
      throw new Error(fallbackReason instanceof Error ? fallbackReason.message : "The Gerrit query failed.");
    }
  }
}

async function accountIdentity(server: URL, username: string, accountId: number, fallbackName?: string): Promise<Identity> {
  try {
    const details = await fetchJson<GerritAccount>(endpoint(server, `accounts/${accountId}`));
    return { username, accountId, name: details.name ?? fallbackName, mode: "account" };
  } catch {
    return { username, accountId, name: fallbackName, mode: "account" };
  }
}

async function resolveIdentity(server: URL, username: string): Promise<Identity> {
  try {
    const url = endpoint(server, "accounts/");
    url.searchParams.set("q", username);
    url.searchParams.set("n", "10");
    const accounts = await fetchJson<GerritAccount[]>(url);
    const exact = accounts.filter((account) => account.username?.toLowerCase() === username.toLowerCase());
    let account: GerritAccount | undefined;
    if (exact.length === 1) account = exact[0];
    else if (accounts.length === 1) account = accounts[0];
    if (account?._account_id !== undefined) return accountIdentity(server, username, account._account_id, account.name);
  } catch {
    // Anonymous account search is optional. Change queries can still use the username.
  }
  return { username, mode: "username" };
}

function isIdentity(account: GerritAccount | undefined, identity: Identity) {
  if (!account) return false;
  if (identity.accountId !== undefined && account._account_id === identity.accountId) return true;
  return account.username?.toLowerCase() === identity.username.toLowerCase();
}

function currentPatchset(change: GerritChange) {
  if (change.current_revision) return change.revisions?.[change.current_revision]?._number;
  return Math.max(0, ...Object.values(change.revisions ?? {}).map((revision) => revision._number)) || undefined;
}

function ciState(labels: Record<string, GerritLabel>): { state: DashboardCiState; fact?: string } {
  const entries = Object.entries(labels).filter(([name]) => /(^|[-_ ])(verified|ci|build)($|[-_ ])/i.test(name) || /^verified$/i.test(name));
  if (entries.length === 0) return { state: "unknown", fact: "CI: unknown" };
  if (entries.some(([, label]) => label.rejected || label.all?.some((vote) => (vote.value ?? 0) < 0))) {
    return { state: "failed", fact: "CI failed" };
  }
  if (entries.some(([, label]) => label.approved || label.all?.some((vote) => (vote.value ?? 0) > 0))) {
    return { state: "passed", fact: "CI passed" };
  }
  return { state: "running", fact: "CI pending" };
}

function blockingReview(labels: Record<string, GerritLabel>) {
  return Object.entries(labels).find(([name, label]) => !/(verified|ci|build)/i.test(name) && (
    label.rejected || label.all?.some((vote) => (vote.value ?? 0) < 0)
  ));
}

function identityVote(labels: Record<string, GerritLabel>, identity: Identity) {
  for (const [name, label] of Object.entries(labels)) {
    const vote = label.all?.find((account) => isIdentity(account, identity));
    if (vote?.value) return { name, value: vote.value };
  }
  return undefined;
}

function hasAttention(change: GerritChange, identity: Identity) {
  return Object.values(change.attention_set ?? {}).some(({ account }) => isIdentity(account, identity));
}

function sourceUrl(server: URL, change: GerritChange) {
  const project = change.project.split("/").map(encodeURIComponent).join("/");
  return endpoint(server, `c/${project}/+/${change._number}`).toString();
}

type Classification = Pick<DashboardChange, "group" | "evidence" | "diagnosis">;

function classifyOwnedChange({
  change,
  ci,
  negative,
  unresolved,
  conflict,
}: {
  change: GerritChange;
  ci: { state: DashboardCiState };
  negative: [string, GerritLabel] | undefined;
  unresolved: number | undefined;
  conflict: boolean;
}): Classification {
  if (conflict) return { group: "action", evidence: "explicit", diagnosis: "Your change has a merge conflict" };
  if (negative) return { group: "action", evidence: "explicit", diagnosis: `Blocked by ${negative[0]}` };
  if (ci.state === "failed") return { group: "action", evidence: "explicit", diagnosis: "CI failed on your change" };
  if (unresolved) return { group: "action", evidence: "explicit", diagnosis: "Your change has unresolved feedback" };
  if (change.submittable) return { group: "ready", evidence: "explicit", diagnosis: "All known submit requirements are satisfied" };
  return {
    group: "waiting",
    evidence: change.submit_requirements ? "derived" : "unknown",
    diagnosis: ci.state === "running" ? "Waiting for CI" : "Waiting for review or submit requirements",
  };
}

function classifyReviewingChange(
  change: GerritChange,
  labels: Record<string, GerritLabel>,
  identity: Identity,
  attentionAvailable: boolean,
): Classification {
  if (hasAttention(change, identity)) {
    return { group: "action", evidence: "explicit", diagnosis: "Gerrit requests your attention" };
  }
  const vote = identityVote(labels, identity);
  if (vote) {
    const value = `${vote.value > 0 ? "+" : ""}${vote.value}`;
    return { group: "waiting", evidence: "derived", diagnosis: `Your ${vote.name} ${value} is on the current patchset` };
  }
  if (attentionAvailable) {
    return { group: "unclear", evidence: "unknown", diagnosis: "No explicit turn signal; decide whether this needs review" };
  }
  return { group: "unclear", evidence: "inferred", diagnosis: "Likely needs triage; attention data is unavailable" };
}

function classify({
  server,
  change,
  scopes,
  identity,
  attentionAvailable,
}: {
  server: URL;
  change: GerritChange;
  scopes: DashboardScope[];
  identity: Identity;
  attentionAvailable: boolean;
}): DashboardChange {
  const labels = change.labels ?? {};
  const ci = ciState(labels);
  const negative = blockingReview(labels);
  const unresolved = change.unresolved_comment_count;
  const unsatisfied = change.submit_requirements?.filter((requirement) => requirement.status === "UNSATISFIED") ?? [];
  const conflict = change.mergeable === false;
  const facts = [ci.fact].filter((fact): fact is string => Boolean(fact));
  if (unresolved) facts.push(`${unresolved} unresolved`);
  if (conflict) facts.unshift("Merge conflict");
  if (negative) facts.unshift(`${negative[0]} blocked`);
  if (unsatisfied.length > 0 && !negative) facts.push(`${unsatisfied.length} requirement${unsatisfied.length === 1 ? "" : "s"} missing`);
  const classification = scopes.includes("mine")
    ? classifyOwnedChange({ change, ci, negative, unresolved, conflict })
    : classifyReviewingChange(change, labels, identity, attentionAvailable);

  return {
    id: change.id,
    sourceUrl: sourceUrl(server, change),
    changeNumber: change._number,
    subject: change.subject,
    project: change.project,
    branch: change.branch,
    topic: change.topic,
    status: change.work_in_progress ? "WIP" : change.status,
    updated: change.updated,
    patchset: currentPatchset(change),
    owner: {
      name: change.owner.name ?? change.owner.username ?? "Hidden or deleted account",
      username: change.owner.username,
      avatarUrl: change.owner.avatars?.at(-1)?.url,
    },
    scopes,
    group: classification.group,
    evidence: classification.evidence,
    facts: facts.slice(0, 3),
    diagnosis: classification.diagnosis,
    ci: ci.state,
    unresolvedCount: unresolved,
    submittable: change.submittable,
  };
}

export async function GET(request: NextRequest) {
  const serverInput = request.nextUrl.searchParams.get("server")?.trim();
  const username = request.nextUrl.searchParams.get("username")?.trim();
  if (!serverInput || !username) {
    return NextResponse.json({ error: "A Gerrit server URL and username are required." }, { status: 400 });
  }
  if (!/^[A-Za-z0-9._@+-]+$/.test(username)) {
    return NextResponse.json({ error: "Enter an exact Gerrit username, email, or numeric account ID." }, { status: 400 });
  }

  try {
    const server = normalizeGerritServer(serverInput);
    const identityPromise = resolveIdentity(server, username);
    const queries = await Promise.allSettled([
      queryChanges(server, `owner:${username} status:open`),
      queryChanges(server, `reviewer:${username} status:open`),
      queryChanges(server, `attention:${username} status:open`),
    ]);
    if (queries.every((result) => result.status === "rejected")) {
      const first = queries[0];
      throw new Error(first.status === "rejected" && first.reason instanceof Error ? first.reason.message : "The Gerrit server could not be queried.");
    }
    let identity = await identityPromise;
    const ownedResult = queries[0];
    if (identity.mode === "username" && ownedResult.status === "fulfilled") {
      const owners = new Map(ownedResult.value.changes.flatMap((change) => change.owner._account_id === undefined ? [] : [[change.owner._account_id, change.owner] as const]));
      if (owners.size === 1) {
        const [accountId, owner] = owners.entries().next().value as [number, GerritAccount];
        identity = await accountIdentity(server, username, accountId, owner.name);
      }
    }
    const warnings: DashboardWarning[] = [];
    if (identity.mode === "username") {
      warnings.push({ source: "identity", message: "The account could not be resolved anonymously; activity matching uses the username." });
    }

    const scopesById = new Map<string, Set<DashboardScope>>();
    const changesById = new Map<string, GerritChange>();
    const sources: ("mine" | "reviewing" | "attention")[] = ["mine", "reviewing", "attention"];
    const sourceLabel = { mine: "Owned changes", reviewing: "Incoming reviews", attention: "Attention" };
    queries.forEach((result, index) => {
      const source = sources[index];
      if (result.status === "rejected") {
        warnings.push({ source, message: `${sourceLabel[source]} unavailable: ${result.reason instanceof Error ? result.reason.message : "query failed"}` });
        return;
      }
      if (result.value.warning) warnings.push({ source: source === "attention" ? "attention" : source, message: result.value.warning });
      for (const change of result.value.changes) {
        changesById.set(change.id, change);
        const scopes = scopesById.get(change.id) ?? new Set<DashboardScope>();
        scopes.add(source === "mine" ? "mine" : "reviewing");
        scopesById.set(change.id, scopes);
      }
    });

    const attentionAvailable = queries[2].status === "fulfilled";
    const changes = [...changesById.values()].map((change) => {
      const scopes = [...(scopesById.get(change.id) ?? new Set<DashboardScope>())];
      const normalizedScopes: DashboardScope[] = scopes.includes("mine") ? ["mine"] : scopes;
      return classify({ server, change, scopes: normalizedScopes, identity, attentionAvailable });
    });

    const data: DashboardData = {
      server: server.toString(),
      fetchedAt: new Date().toISOString(),
      identity,
      changes,
      warnings,
    };
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
    });
  } catch (reason) {
    return NextResponse.json({ error: reason instanceof Error ? reason.message : "The dashboard could not be loaded." }, { status: 400 });
  }
}

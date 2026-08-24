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

async function stackBlockerCount(server: URL, change: GerritChange) {
  const together = await fetchJson<GerritChange[]>(endpoint(server, `changes/${change._number}/submitted_together`));
  return together.filter((related) => related.id !== change.id && related.status === "NEW" && related.submittable === false).length;
}

type Classification = Pick<DashboardChange, "group" | "evidence" | "diagnosis">;

function classifyOwnedChange({
  change,
  ci,
  negative,
  unresolved,
  conflict,
  stackBlockers,
}: {
  change: GerritChange;
  ci: { state: DashboardCiState };
  negative: [string, GerritLabel] | undefined;
  unresolved: number | undefined;
  conflict: boolean;
  stackBlockers: number;
}): Classification {
  if (conflict) return { group: "action", evidence: "explicit", diagnosis: "Your change has a merge conflict" };
  if (negative) return { group: "action", evidence: "explicit", diagnosis: `Blocked by ${negative[0]}` };
  if (ci.state === "failed") return { group: "action", evidence: "explicit", diagnosis: "CI failed on your change" };
  if (unresolved) return { group: "action", evidence: "explicit", diagnosis: "Your change has unresolved feedback" };
  if (change.submittable && stackBlockers > 0) {
    return { group: "ready-stuck", evidence: "explicit", diagnosis: `Ready, but ${stackBlockers} related change${stackBlockers === 1 ? " is" : "s are"} not submittable` };
  }
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
  if (change.work_in_progress) {
    return { group: "waiting", evidence: "explicit", diagnosis: "Waiting for the author to mark this ready for review" };
  }
  if (change.mergeable === false) {
    return { group: "waiting", evidence: "explicit", diagnosis: "Waiting for the author to resolve a merge conflict" };
  }
  if (ciState(labels).state === "failed") {
    return { group: "waiting", evidence: "explicit", diagnosis: "Waiting for the author to fix CI" };
  }
  if (hasAttention(change, identity)) {
    return { group: "action", evidence: "explicit", diagnosis: "Gerrit requests your attention" };
  }
  const vote = identityVote(labels, identity);
  if (vote) {
    const value = `${vote.value > 0 ? "+" : ""}${vote.value}`;
    return { group: "waiting", evidence: "derived", diagnosis: `Your ${vote.name} ${value} is on the current patchset` };
  }
  const ci = ciState(labels);
  if (attentionAvailable) {
    const diagnosis = ci.state === "passed"
      ? "Ready for review, but Gerrit has not requested your attention"
      : "No explicit turn signal; decide whether this needs review";
    return { group: "unclear", evidence: "unknown", diagnosis };
  }
  return { group: "unclear", evidence: "inferred", diagnosis: "Likely needs triage; attention data is unavailable" };
}

function classifyUnrelatedChange(change: GerritChange): Classification {
  if (change.work_in_progress) return { group: "waiting", evidence: "explicit", diagnosis: "Work in progress outside your review scope" };
  if (change.mergeable === false) return { group: "waiting", evidence: "explicit", diagnosis: "Open change outside your review scope with a merge conflict" };
  if (change.submittable) return { group: "ready", evidence: "explicit", diagnosis: "Open change outside your review scope is submittable" };
  return { group: "waiting", evidence: "explicit", diagnosis: "Open change outside your review scope" };
}

function requirementFact(name: string) {
  if (/owners?|code[- ]review from owners/i.test(name)) return "Needs owner approval";
  if (/^code[- ]review$/i.test(name)) return "Needs Code-Review +2";
  return `Needs ${name}`;
}

function classify({
  server,
  change,
  scopes,
  identity,
  attentionAvailable,
  stackBlockers = 0,
}: {
  server: URL;
  change: GerritChange;
  scopes: DashboardScope[];
  identity: Identity;
  attentionAvailable: boolean;
  stackBlockers?: number;
}): DashboardChange {
  const labels = change.labels ?? {};
  const ci = ciState(labels);
  const negative = blockingReview(labels);
  const unresolved = change.unresolved_comment_count;
  const requirements = change.submit_requirements ?? [];
  const codeReviewBlocked = Boolean(negative && /^code[- ]review$/i.test(negative[0]));
  const requirementFacts = requirements.flatMap((requirement) => {
    if (requirement.status === "ERROR") return [`${requirement.name} requirement error`];
    if (requirement.status !== "UNSATISFIED") return [];
    const fact = requirementFact(requirement.name);
    return codeReviewBlocked && fact === "Needs Code-Review +2" ? [] : [fact];
  }).sort((left, right) => {
    const priority = (fact: string) => {
      if (fact === "Needs owner approval") return 0;
      if (fact.endsWith(" requirement error")) return 1;
      return 2;
    };
    return priority(left) - priority(right);
  });
  const conflict = change.mergeable === false;
  const facts = [...new Set([
    ...requirementFacts,
    ...(conflict ? ["Merge conflict"] : []),
    ...(negative ? [`${negative[0]} blocked`] : []),
    ...(ci.fact ? [ci.fact] : []),
    ...(unresolved ? [`${unresolved} unresolved`] : []),
    ...(stackBlockers ? [`${stackBlockers} blocked stack change${stackBlockers === 1 ? "" : "s"}`] : []),
  ])];
  const classification: Classification = change.status === "MERGED"
    ? { group: "merged", evidence: "explicit", diagnosis: "Submitted in Gerrit" }
    : scopes.includes("mine")
      ? classifyOwnedChange({ change, ci, negative, unresolved, conflict, stackBlockers })
      : scopes.includes("reviewing")
        ? classifyReviewingChange(change, labels, identity, attentionAvailable)
        : classifyUnrelatedChange(change);

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
    requirements,
    unresolvedCount: unresolved,
    submittable: change.submittable,
  };
}

export async function GET(request: NextRequest) {
  const serverInput = request.nextUrl.searchParams.get("server")?.trim();
  const accountInput = request.nextUrl.searchParams.get("account")?.trim();
  const includeEverything = request.nextUrl.searchParams.get("scope") === "everything";
  const includeMerged = request.nextUrl.searchParams.get("state") === "merged";
  const accountId = accountInput && /^\d+$/.test(accountInput) ? Number(accountInput) : undefined;
  const username = request.nextUrl.searchParams.get("username")?.trim() ?? accountInput;
  if (!serverInput || !username) {
    return NextResponse.json({ error: "A Gerrit server and public account identity are required." }, { status: 400 });
  }
  if (!/^[A-Za-z0-9._@+-]+$/.test(username)) {
    return NextResponse.json({ error: "Enter an exact Gerrit username, email, or numeric account ID." }, { status: 400 });
  }

  try {
    const server = normalizeGerritServer(serverInput);
    const identityQuery = accountId === undefined ? username : String(accountId);
    const identityPromise = accountId === undefined
      ? resolveIdentity(server, username)
      : accountIdentity(server, username, accountId);
    const statusQuery = includeMerged ? "status:merged" : "status:open";
    const queries = await Promise.allSettled([
      queryChanges(server, `owner:${identityQuery} ${statusQuery}`),
      queryChanges(server, `reviewer:${identityQuery} ${statusQuery}`),
      queryChanges(server, `attention:${identityQuery} ${statusQuery}`),
      ...(includeEverything ? [queryChanges(server, statusQuery)] : []),
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
    const sources: ("mine" | "reviewing" | "attention" | "everything")[] = ["mine", "reviewing", "attention", "everything"];
    const sourceLabel = { mine: "Owned changes", reviewing: "Incoming reviews", attention: "Attention", everything: "All changes" };
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
        scopes.add(source === "mine" ? "mine" : source === "everything" ? "everything" : "reviewing");
        scopesById.set(change.id, scopes);
      }
    });

    const attentionAvailable = queries[2].status === "fulfilled";
    const readyOwnedChanges = [...changesById.values()].filter((change) => (
      change.submittable && scopesById.get(change.id)?.has("mine")
    ));
    const stackBlockerEntries = await Promise.all(readyOwnedChanges.map(async (change) => {
      try {
        return [change.id, await stackBlockerCount(server, change)] as const;
      } catch {
        return [change.id, 0] as const;
      }
    }));
    const stackBlockersById = new Map(stackBlockerEntries);
    const changes = [...changesById.values()].map((change) => {
      const scopes = [...(scopesById.get(change.id) ?? new Set<DashboardScope>())];
      const normalizedScopes: DashboardScope[] = scopes.includes("mine")
        ? ["mine", ...(scopes.includes("everything") ? ["everything" as const] : [])]
        : scopes;
      return classify({ server, change, scopes: normalizedScopes, identity, attentionAvailable, stackBlockers: stackBlockersById.get(change.id) });
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

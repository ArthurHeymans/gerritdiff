import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

type ParsedGerritUrl = {
  origin: string;
  /** HTTP authority, including a non-default web port. */
  host: string;
  /** Hostname only; suitable for the separately ported SSH destination. */
  sshHost: string;
  change: string;
  revision: string;
  /** Project inferred from a modern Gerrit URL, when present. */
  project?: string;
};

type GerritAccount = {
  _account_id?: number;
  name?: string;
  display_name?: string;
  email?: string;
  username?: string;
  avatars?: Array<{ url: string; height: number }>;
  value?: number;
};

type GerritDetail = {
  _number: number;
  subject: string;
  project: string;
  branch: string;
  status: string;
  mergeable?: boolean;
  work_in_progress?: boolean;
  owner: GerritAccount;
  reviewers?: Record<string, GerritAccount[]>;
  labels?: Record<string, { all?: GerritAccount[] }>;
  messages?: Array<{ message: string; _revision_number?: number }>;
  current_revision: string;
  revisions: Record<string, {
    _number: number;
    created?: string;
    uploader?: GerritAccount;
    commit?: { subject?: string; message?: string; parents?: { commit: string }[] };
  }>;
  updated: string;
  insertions?: number;
  deletions?: number;
};

export function parseGerritUrl(input: string): ParsedGerritUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a valid Gerrit URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) Gerrit URLs are supported.");

  const fullPath = `${url.pathname}${url.hash}`;
  const modern = fullPath.match(/\/\+\/(\d+)(?:\/(\d+))?/);
  const legacy = fullPath.match(/\/(?:#\/)?c\/(\d+)(?:\/(\d+))?/);
  const match = modern ?? legacy;
  if (!match) throw new Error("That doesn't look like a Gerrit change URL.");
  const sshHost = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const projectMatch = url.pathname.match(/^\/c\/(.+?)\/\+\/\d+/);
  const project = projectMatch ? decodeURIComponent(projectMatch[1]) : undefined;
  return { origin: url.origin, host: url.host, sshHost, change: match[1], revision: match[2] ?? "current", project };
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const value = address.toLowerCase();
  return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:") || value.startsWith("::ffff:127.");
}

async function assertPublicUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("The remote server provided an invalid URL.");
  }
  const hostname = url.hostname;
  if (hostname === "localhost" || hostname.endsWith(".local")) throw new Error("Local Gerrit hosts aren't available from the hosted viewer.");
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Private network addresses are not allowed.");
}

function stripXssi(text: string): string {
  return text.replace(/^\uFEFF?\s*\)\]\}'\s*/, "");
}

export function parseGerritJson<T>(text: string): T {
  try {
    return JSON.parse(stripXssi(text)) as T;
  } catch {
    throw new Error("Gerrit returned an invalid response.");
  }
}

export async function publicFetch(url: string, accept = "application/json", allowNotFound = false) {
  await assertPublicUrl(url);
  const maxAttempts = 3;
  let response: Response | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      response = await fetch(url, {
        headers: { Accept: accept, "User-Agent": "GerritDiff/0.1" },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (attempt === maxAttempts - 1) throw new Error("The Gerrit server could not be reached.");
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      continue;
    }
    if (![429, 502, 503, 504].includes(response.status) || attempt === maxAttempts - 1) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 250 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (!response) throw new Error("The Gerrit server could not be reached.");
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("This resource is private or anonymous access is disabled.");
    if (response.status === 404) throw new Error("Resource not found. Check the URL and its permissions.");
    throw new Error(`Gerrit returned ${response.status}.`);
  }
  return response;
}

export async function resolveChange(sourceUrl: string) {
  const parsed = parseGerritUrl(sourceUrl);
  const detailUrl = `${parsed.origin}/changes/${encodeURIComponent(parsed.change)}/detail?o=ALL_REVISIONS&o=ALL_COMMITS&o=DETAILED_LABELS&o=DETAILED_ACCOUNTS&o=MESSAGES`;
  const detailResponse = await publicFetch(detailUrl);
  if (!detailResponse) throw new Error("Change not found.");
  const detail = parseGerritJson<GerritDetail>(await detailResponse.text());
  const selectedRevision = parsed.revision === "current"
    ? Object.entries(detail.revisions).find(([id]) => id === detail.current_revision)
    : Object.entries(detail.revisions).find(([, item]) => item._number === Number(parsed.revision));
  if (!selectedRevision) throw new Error("Patchset not found.");
  const [revision, revisionInfo] = selectedRevision;
  return { parsed, detail, revision, revisionNumber: revisionInfo._number };
}

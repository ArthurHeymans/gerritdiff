export type GerritComment = {
  id: string;
  path: string;
  patchSet: number;
  line?: number;
  side: "PARENT" | "REVISION";
  /** 1-based merge-parent number when side is PARENT; omitted for the auto-merge base. */
  parent?: number;
  range?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
  /** Original Gerrit coordinates retained when /COMMIT_MSG is shown without its generated header. */
  gerritLine?: number;
  gerritRange?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
  contextLines?: { lineNumber: number; text: string }[];
  author: { name: string; email?: string; avatarUrl?: string };
  message: string;
  updated: string;
  unresolved: boolean;
  inReplyTo?: string;
  ported?: boolean;
};

export type ComparisonFile = {
  name: string;
  previousName?: string;
  status: "A" | "D" | "R" | "C" | "M";
  baseContent?: string;
  targetContent?: string;
  binary?: boolean;
};

export type RelatedChange = {
  project: string;
  changeNumber?: number;
  revisionNumber?: number;
  currentRevisionNumber?: number;
  subject: string;
  status?: string;
  commit: string;
  sourceUrl?: string;
  isCurrent: boolean;
};

export type GerritReviewer = {
  name: string;
  email?: string;
  username?: string;
  avatarUrl?: string;
  codeReview?: number;
  verified?: number;
};

export type ChangeCheck = {
  name: string;
  result: "SUCCESS" | "FAILURE" | "UNSTABLE" | "ABORTED" | "NOT_BUILT";
  url: string;
};

export type DashboardProfile = {
  server: string;
  username: string;
  accountId?: number;
};

export type DashboardScope = "mine" | "reviewing" | "everything";
export type DashboardGroup = "action" | "unclear" | "waiting" | "ready-stuck" | "ready" | "merged";
export type DashboardEvidence = "explicit" | "derived" | "inferred" | "unknown";
export type DashboardCiState = "failed" | "running" | "passed" | "unknown";

export type DashboardRequirement = {
  name: string;
  status: "SATISFIED" | "UNSATISFIED" | "OVERRIDDEN" | "NOT_APPLICABLE" | "ERROR";
};

export type DashboardOwnership = {
  status: "owner-all" | "owner-some" | "not-owner" | "approved" | "unavailable";
  ownedPaths: number;
  pendingPaths: number;
  eligibleOwners: string[];
};

export type DashboardChange = {
  id: string;
  sourceUrl: string;
  changeNumber: number;
  subject: string;
  project: string;
  branch: string;
  topic?: string;
  status: string;
  updated: string;
  patchset?: number;
  owner: { name: string; email?: string; username?: string; avatarUrl?: string };
  scopes: DashboardScope[];
  group: DashboardGroup;
  evidence: DashboardEvidence;
  facts: string[];
  diagnosis: string;
  ci: DashboardCiState;
  requirements: DashboardRequirement[];
  unresolvedCount?: number;
  submittable?: boolean;
};

export type DashboardWarning = {
  source: "identity" | DashboardScope | "attention" | "details";
  message: string;
};

export type DashboardData = {
  server: string;
  fetchedAt: string;
  identity: {
    username: string;
    accountId?: number;
    name?: string;
    mode: "account" | "username";
  };
  changes: DashboardChange[];
  warnings: DashboardWarning[];
  /** Whether this response queried submitted changes instead of open changes. */
  mergedLoaded?: boolean;
};

export type ChangeData = {
  /** Gerrit's HTTP authority, used to scope UI settings and credentials. */
  host: string;
  /** Gerrit's default SSH hostname, without the HTTP port. */
  sshHost: string;
  sourceUrl: string;
  changeNumber: number;
  subject: string;
  commitMessage: string;
  // Gerrit's /COMMIT_MSG magic file prefixes the message with generated header
  // lines (Parent/Merge Of, Author, AuthorDate, Commit, CommitDate, blank), so
  // comment line numbers on that path are offset by this many lines.
  commitMessageLineOffset: number;
  /** Equivalent /COMMIT_MSG offset for an explicitly selected base patchset. */
  baseCommitMessageLineOffset?: number;
  project: string;
  branch: string;
  status: string;
  owner: { name: string; email?: string; username?: string; avatarUrl?: string };
  reviewers: GerritReviewer[];
  checks: ChangeCheck[];
  revision: string;
  revisionNumber: number;
  revisions: { revision: string; number: number; created?: string; uploader?: string }[];
  baseRevisionNumber?: number;
  comparisonFiles?: ComparisonFile[];
  updated: string;
  insertions: number;
  deletions: number;
  patch: string;
  comments: GerritComment[];
  relationChain: RelatedChange[];
};

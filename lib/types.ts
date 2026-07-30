export type GerritComment = {
  id: string;
  path: string;
  patchSet: number;
  line?: number;
  side: "PARENT" | "REVISION";
  range?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
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
  avatarUrl?: string;
  codeReview?: number;
  verified?: number;
};

export type ChangeData = {
  host: string;
  sourceUrl: string;
  changeNumber: number;
  subject: string;
  commitMessage: string;
  // Gerrit's /COMMIT_MSG magic file prefixes the message with generated header
  // lines (Parent/Merge Of, Author, AuthorDate, Commit, CommitDate, blank), so
  // comment line numbers on that path are offset by this many lines.
  commitMessageLineOffset: number;
  project: string;
  branch: string;
  status: string;
  owner: { name: string; email?: string; avatarUrl?: string };
  reviewers: GerritReviewer[];
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

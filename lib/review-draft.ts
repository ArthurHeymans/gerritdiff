import type { LocalReviewComment } from "./review-comments.ts";

export type LocalReplyDraft = { key: string; message: string; resolved: boolean };
export type ReviewDraft = {
  version: 1;
  comments: LocalReviewComment[];
  replies: LocalReplyDraft[];
  message: string;
  vote: string;
};

export type ReviewEditorBuffer =
  | ({ kind: "inline" } & LocalReviewComment)
  | ({ kind: "reply" } & LocalReplyDraft)
  | { kind: "scope"; path: string; key: string | null; message: string; resolved: boolean };

export function parseReviewEditorBuffers(raw: string | null): { id: string; value: ReviewEditorBuffer }[] {
  if (!raw) return [];
  try {
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry): entry is { id: string; value: ReviewEditorBuffer } => {
      if (!record(entry) || typeof entry.id !== "string" || !record(entry.value)) return false;
      const value = entry.value;
      if (value.kind === "inline") return parseReviewDraft(JSON.stringify({ version: 1, comments: [value], replies: [], message: "", vote: "" })) !== null;
      if (value.kind === "reply") return typeof value.key === "string" && typeof value.message === "string" && typeof value.resolved === "boolean";
      return value.kind === "scope" && typeof value.path === "string" && (value.key === null || typeof value.key === "string") && typeof value.message === "string" && typeof value.resolved === "boolean";
    });
  } catch { return []; }
}

export function reviewDraftKey(host: string, project: string, change: number, revision: string, base?: number) {
  return `gerritdiff:review-draft:${JSON.stringify([host, project, change, revision, base ?? "parent"])}`;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const side = (value: unknown) => value === undefined || value === "additions" || value === "deletions";
const textRange = (value: unknown) => value === undefined || (record(value)
  && nonnegative(value.start_line) && nonnegative(value.end_line)
  && nonnegative(value.start_character) && nonnegative(value.end_character));

/** Treat tab storage as untrusted; a malformed entry must never break the viewer. */
export function parseReviewDraft(raw: string | null): ReviewDraft | null {
  if (!raw) return null;
  try {
    const draft: unknown = JSON.parse(raw);
    if (!record(draft) || draft.version !== 1 || typeof draft.message !== "string"
      || typeof draft.vote !== "string" || !["", "-2", "-1", "0", "1", "2"].includes(draft.vote)
      || !Array.isArray(draft.comments) || !Array.isArray(draft.replies)) return null;
    if (!draft.comments.every((comment: unknown) => record(comment)
      && typeof comment.key === "string" && typeof comment.path === "string" && typeof comment.message === "string"
      && record(comment.range) && nonnegative(comment.range.start) && nonnegative(comment.range.end)
      && side(comment.range.side) && side(comment.range.endSide)
      && textRange(comment.textRange) && textRange(comment.gerritRange)
      && (comment.gerritLine === undefined || nonnegative(comment.gerritLine))
      && (comment.parent === undefined || nonnegative(comment.parent))
      && (comment.inReplyTo === undefined || typeof comment.inReplyTo === "string")
      && (comment.unresolved === undefined || typeof comment.unresolved === "boolean"))) return null;
    if (!draft.replies.every((reply: unknown) => record(reply)
      && typeof reply.key === "string" && typeof reply.message === "string" && typeof reply.resolved === "boolean")) return null;
    return draft as ReviewDraft;
  } catch {
    return null;
  }
}
